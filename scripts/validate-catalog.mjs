import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "catalog", "index.json");
const channelsRoot = join(root, "channels");

if (!existsSync(catalogPath)) {
  throw new Error(`Missing catalog index at ${catalogPath}.`);
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
assertCatalogShape(catalog, "catalog/index.json");

const catalogIds = new Map(catalog.packages.map((entry) => [entry.id, entry]));
const channelFiles = existsSync(channelsRoot)
  ? readdirSync(channelsRoot).filter((entry) => entry.endsWith(".json")).sort()
  : [];

for (const channelFile of channelFiles) {
  const channelPath = join(channelsRoot, channelFile);
  const channel = JSON.parse(readFileSync(channelPath, "utf8"));
  assertChannelShape(channel, `channels/${channelFile}`);

  for (const entry of channel.packages) {
    if (!catalogIds.has(entry.id)) {
      throw new Error(`Channel ${channelFile} references ${entry.id}, which is missing from catalog/index.json.`);
    }
    if (entry.channel !== channel.id) {
      throw new Error(`channels/${channelFile} entry ${entry.id} must declare channel '${channel.id}'.`);
    }
    const artifactUri = assertSignedArtifact(entry, `channels/${channelFile}`);
    if (artifactUri && process.env.SKIP_REMOTE_ASSET_CHECK !== "1") {
      await assertRemoteAsset(artifactUri);
    }
  }
}

function assertCatalogShape(payload, label) {
  if (payload.schemaVersion !== 1) {
    throw new Error(`${label} must declare schemaVersion 1.`);
  }
  if (!Array.isArray(payload.packages)) {
    throw new Error(`${label} must contain a packages array.`);
  }
  assertSortedAndUnique(payload.packages, label);
  assertPluginPresentationMetadata(payload.packages, label);
  assertCatalogArtifactPolicy(payload.packages, label);
}

function assertChannelShape(payload, label) {
  if (payload.schemaVersion !== 1) {
    throw new Error(`${label} must declare schemaVersion 1.`);
  }
  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw new Error(`${label} must declare a non-empty id.`);
  }
  if (!Array.isArray(payload.packages)) {
    throw new Error(`${label} must contain a packages array.`);
  }
  assertSortedAndUnique(payload.packages, label);
  assertPluginPresentationMetadata(payload.packages, label);
  assertCatalogArtifactPolicy(payload.packages, label);
}

function assertSortedAndUnique(entries, label) {
  const ids = entries.map((entry) => entry.id);
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  if (ids.join("\n") !== sorted.join("\n")) {
    throw new Error(`${label} packages must be sorted by id.`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} packages contain duplicate ids.`);
  }
}

function assertCatalogArtifactPolicy(entries, label) {
  for (const entry of entries) {
    if (entry.channel !== "stable") {
      continue;
    }

    assertSignedArtifact(entry, label);
  }
}

function assertSignedArtifact(entry, label) {
  if (entry.channel === "next" && (!entry.artifact || typeof entry.artifact.uri !== "string")) {
    return undefined;
  }
  if (!entry.artifact || typeof entry.artifact.uri !== "string") {
    throw new Error(`${label} entry ${entry.id} must include an installable artifact.`);
  }
  if (typeof entry.artifact.sha256 !== "string" || entry.artifact.sha256.length !== 64) {
    throw new Error(`${label} entry ${entry.id} must include a sha256 digest.`);
  }
  if (typeof entry.artifact.signature !== "string" || entry.artifact.signature.length === 0) {
    throw new Error(`${label} entry ${entry.id} must include a signature.`);
  }
  if (typeof entry.artifact.publicKeyPem !== "string" || entry.artifact.publicKeyPem.length === 0) {
    throw new Error(`${label} entry ${entry.id} must include a publicKeyPem.`);
  }
  return entry.artifact.uri;
}

function assertPluginPresentationMetadata(entries, label) {
  for (const entry of entries) {
    if (entry.kind !== "plugin") {
      continue;
    }

    if (typeof entry.displayName !== "string" || entry.displayName.length === 0) {
      throw new Error(`${label} entry ${entry.id} must include a displayName.`);
    }
    if (typeof entry.description !== "string" || entry.description.length === 0) {
      throw new Error(`${label} entry ${entry.id} must include a description.`);
    }
    if (typeof entry.domainGroup !== "string" || entry.domainGroup.length === 0) {
      throw new Error(`${label} entry ${entry.id} must include a domainGroup.`);
    }
    if (!entry.defaultCategory || typeof entry.defaultCategory !== "object") {
      throw new Error(`${label} entry ${entry.id} must include a defaultCategory object.`);
    }

    for (const field of ["id", "label", "subcategoryId", "subcategoryLabel"]) {
      if (typeof entry.defaultCategory[field] !== "string" || entry.defaultCategory[field].length === 0) {
        throw new Error(`${label} entry ${entry.id} defaultCategory.${field} must be a non-empty string.`);
      }
    }
  }
}

async function assertRemoteAsset(uri) {
  let response = await fetch(uri, {
    method: "HEAD",
    redirect: "follow",
    headers: {
      "user-agent": "gutu-catalog-validate"
    }
  });

  if (!response.ok) {
    response = await fetch(uri, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "gutu-catalog-validate"
      }
    });
  }

  if (!response.ok) {
    throw new Error(`Remote asset check failed for ${uri}: ${response.status}.`);
  }
}
