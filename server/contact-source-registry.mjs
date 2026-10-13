import { previewWeFlow } from "./weflow-adapter.mjs";
import { allowsLegacyNullSourceRef, buildSourceScopedContactId } from "../src/importer.js";
import { MAX_CONTACTS } from "../src/limits.js";

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export class ContactSourceError extends Error {
  constructor(message, { status = 422, code = "CONTACT_SOURCE_ERROR", details = null } = {}) {
    super(message);
    this.name = "ContactSourceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function freezeDescriptor(descriptor, platform) {
  const supportedOnHost = descriptor.platforms.includes("any") || descriptor.platforms.includes(platform);
  return Object.freeze({
    ...descriptor,
    capabilities: Object.freeze([...descriptor.capabilities]),
    platforms: Object.freeze([...descriptor.platforms]),
    supportedOnHost,
  });
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || !SOURCE_ID_PATTERN.test(descriptor.id || "")) {
    throw new TypeError("联系人数据源需要安全、稳定的 id。");
  }
  if (typeof descriptor.displayName !== "string" || !descriptor.displayName.trim()) {
    throw new TypeError(`联系人数据源 ${descriptor.id} 缺少显示名称。`);
  }
  if (!Array.isArray(descriptor.platforms) || !descriptor.platforms.length) {
    throw new TypeError(`联系人数据源 ${descriptor.id} 缺少平台声明。`);
  }
  if (!Array.isArray(descriptor.capabilities) || !descriptor.capabilities.includes("contacts")) {
    throw new TypeError(`联系人数据源 ${descriptor.id} 至少要声明 contacts 能力。`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value, minimum, maximum) {
  return typeof value === "string"
    && !/[\u0000-\u001F\u007F]/.test(value)
    && value.trim().length >= minimum
    && value.length <= maximum;
}

function isValidOptionalDate(value) {
  return value === null || value === undefined
    || (typeof value === "string" && value.length <= 64 && !Number.isNaN(new Date(value).getTime()));
}

function isValidPreviewContact(contact, descriptor) {
  const validBase = isRecord(contact)
    && isBoundedString(contact.id, 1, 128)
    && isBoundedString(contact.name, 1, 48)
    && typeof contact.initials === "string"
    && contact.initials.length <= 8
    && ["maintain", "ignore", "unset"].includes(contact.maintenanceIntent)
    && isValidOptionalDate(contact.lastMessageAt)
    && typeof contact.lastMessageText === "string"
    && contact.lastMessageText.length <= 5_000
    && typeof contact.lastMessageType === "string"
    && contact.lastMessageType.length <= 48
    && Number.isInteger(contact.cadenceDays)
    && contact.cadenceDays >= 7
    && contact.cadenceDays <= 365
    && typeof contact.importedCadenceProvided === "boolean"
    && Array.isArray(contact.customTagIds)
    && contact.customTagIds.length <= 100
    && contact.customTagIds.every((tagId) => typeof tagId === "string" && tagId.length <= 96)
    && Array.isArray(contact.importedTagNames)
    && contact.importedTagNames.length <= 20
    && contact.importedTagNames.every((name) => isBoundedString(name, 1, 18))
    && isBoundedString(contact.source, 1, 96)
    && typeof contact.sourceId === "string"
    && !/[\u0000-\u001F\u007F]/.test(contact.sourceId)
    && contact.sourceId.length <= 128
    && typeof contact.needsReview === "boolean";
  if (!validBase) return false;
  if (contact.sourceRef === null || contact.sourceRef === undefined) {
    return allowsLegacyNullSourceRef(descriptor.id);
  }
  const ref = contact.sourceRef;
  return isRecord(ref)
    && ref.contractVersion === 1
    && ref.providerId === descriptor.id
    && isBoundedString(ref.instanceId, 1, 96)
    && isBoundedString(ref.externalKey, 1, 128)
    && (contact.sourceProviderId === undefined || contact.sourceProviderId === descriptor.id)
    && contact.id === buildSourceScopedContactId(ref.providerId, ref.instanceId, ref.externalKey);
}

function validatePreviewResult(result, descriptor) {
  const valid = isRecord(result)
    && result.ok === true
    && Array.isArray(result.contacts)
    && result.contacts.length <= MAX_CONTACTS
    && result.contacts.every((contact) => isValidPreviewContact(contact, descriptor))
    && new Set(result.contacts.map((contact) => contact.id)).size === result.contacts.length
    && Array.isArray(result.warnings)
    && result.warnings.length <= 20
    && result.warnings.every((warning) => typeof warning === "string" && warning.length <= 1_000)
    && isBoundedString(result.sourceKind, 1, 96);
  if (!valid) {
    throw new ContactSourceError(`${descriptor.displayName} 返回了不符合联系人预览合同的数据。`, {
      status: 502,
      code: "CONTACT_SOURCE_PROTOCOL_ERROR",
      details: { providerId: descriptor.id },
    });
  }
}

function sanitizeSourceMeta(sourceMeta) {
  if (!isRecord(sourceMeta)) return {};
  const safe = {};
  if (isBoundedString(sourceMeta.instanceId, 1, 96)) safe.instanceId = sourceMeta.instanceId;
  if (typeof sourceMeta.partial === "boolean") safe.partial = sourceMeta.partial;
  if (Number.isSafeInteger(sourceMeta.contacts) && sourceMeta.contacts >= 0 && sourceMeta.contacts <= MAX_CONTACTS) {
    safe.contacts = sourceMeta.contacts;
  }
  if (Number.isInteger(sourceMeta.port) && sourceMeta.port >= 1 && sourceMeta.port <= 65_535) {
    safe.port = sourceMeta.port;
  }
  return safe;
}

export function createContactSourceRegistry({ platform = process.platform } = {}) {
  const sources = new Map();

  return Object.freeze({
    register(descriptor, preview = null) {
      validateDescriptor(descriptor);
      if (sources.has(descriptor.id)) throw new TypeError(`联系人数据源 ${descriptor.id} 已注册。`);
      sources.set(descriptor.id, {
        descriptor: freezeDescriptor(descriptor, platform),
        preview,
      });
      return this;
    },

    list() {
      return [...sources.values()].map(({ descriptor }) => descriptor);
    },

    get(sourceId) {
      return sources.get(String(sourceId || ""))?.descriptor || null;
    },

    async preview(sourceId, configuration = {}, context = {}) {
      const entry = sources.get(String(sourceId || ""));
      if (!entry) {
        throw new ContactSourceError("未知的联系人数据源。", {
          status: 404,
          code: "CONTACT_SOURCE_NOT_FOUND",
        });
      }
      if (!entry.descriptor.supportedOnHost) {
        throw new ContactSourceError(`${entry.descriptor.displayName} 不支持当前系统。`, {
          status: 409,
          code: "CONTACT_SOURCE_PLATFORM_UNSUPPORTED",
          details: { platforms: entry.descriptor.platforms },
        });
      }
      if (typeof entry.preview !== "function") {
        throw new ContactSourceError(`${entry.descriptor.displayName} 需要通过文件导入，或先安装对应的本机读取器适配器。`, {
          status: 422,
          code: "CONTACT_SOURCE_PREVIEW_UNAVAILABLE",
        });
      }
      if (!isRecord(configuration)) {
        throw new ContactSourceError("联系人数据源配置必须是 JSON 对象。", {
          status: 422,
          code: "INVALID_CONTACT_SOURCE_CONFIGURATION",
          details: { providerId: entry.descriptor.id },
        });
      }
      const result = await entry.preview(configuration, context);
      validatePreviewResult(result, entry.descriptor);
      return {
        ...result,
        sourceMeta: {
          ...sanitizeSourceMeta(result.sourceMeta),
          providerId: entry.descriptor.id,
          providerContractVersion: 1,
          capabilities: entry.descriptor.capabilities,
        },
        contacts: Array.isArray(result.contacts)
          ? result.contacts.map((contact) => ({
            ...contact,
            sourceProviderId: entry.descriptor.id,
          }))
          : [],
      };
    },
  });
}

export function createDefaultContactSourceRegistry({ platform = process.platform, weflowPreview = previewWeFlow } = {}) {
  return createContactSourceRegistry({ platform })
    .register({
      id: "weflow-http-win32",
      displayName: "WeFlow 本机 API",
      description: "Windows 上从 WeFlow 回环接口提取联系人、会话时间与最近一条消息。",
      platforms: ["win32"],
      transport: "loopback-http",
      availability: "available",
      handledBy: "server",
      capabilities: ["contacts", "sessions", "latestInteraction"],
      privacy: "token-ephemeral",
    }, (configuration, context) => weflowPreview({
      port: configuration.port,
      token: configuration.token,
      signal: context.signal,
    }))
    .register({
      id: "portable-contact-file",
      displayName: "通用联系人文件",
      description: "Windows 与 macOS 都可使用的 JSON / CSV / 关系回响数据源文件。",
      platforms: ["any"],
      transport: "file",
      availability: "available",
      handledBy: "browser",
      capabilities: ["contacts", "latestInteraction"],
      privacy: "local-file",
    })
    .register({
      id: "mac-reader-bridge",
      displayName: "Mac 微信读取器桥接",
      description: "为未来选定的 macOS 微信读取软件保留同一数据合同；当前需要先导出通用文件。",
      platforms: ["darwin"],
      transport: "adapter",
      availability: "adapter-required",
      handledBy: "server",
      capabilities: ["contacts", "sessions", "latestInteraction"],
      privacy: "local-adapter",
    });
}
