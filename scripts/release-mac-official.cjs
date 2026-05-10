#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_APPKEY_DIR = "/Users/west/project/appkey";
const DEFAULT_PRODUCT_NAME = "DeepSeek TUI Desktop";
const DEFAULT_ARCH = "arm64";
const DEFAULT_KEYCHAIN_NAME = "deepseek-release-signing.keychain-db";
const DEFAULT_KEYCHAIN_PASSWORD = "deepseek-release-signing";
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEVELOPER_ID_INTERMEDIATE_URLS = {
  G1: "https://www.apple.com/certificateauthority/DeveloperIDCA.cer",
  G2: "https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"
};

function detectAppleApiKeyId(keyPath) {
  const match = path.basename(String(keyPath || "")).match(/^AuthKey_(.+)\.p8$/);
  return match ? match[1] : "";
}

function findAppleApiKeyPath(appKeyDir) {
  const baseDir = path.resolve(appKeyDir || DEFAULT_APPKEY_DIR);
  if (!fs.existsSync(baseDir)) return "";
  const match = fs.readdirSync(baseDir).find((entry) => /^AuthKey_.+\.p8$/.test(entry));
  return match ? path.join(baseDir, match) : "";
}

function findSigningCertificatePath(appKeyDir) {
  const baseDir = path.resolve(appKeyDir || DEFAULT_APPKEY_DIR);
  if (!fs.existsSync(baseDir)) return "";
  const match = fs.readdirSync(baseDir).find((entry) => /\.p12$/i.test(entry));
  return match ? path.join(baseDir, match) : "";
}

function findSigningCertificateCerPath(appKeyDir) {
  const baseDir = path.resolve(appKeyDir || DEFAULT_APPKEY_DIR);
  if (!fs.existsSync(baseDir)) return "";
  const match = fs.readdirSync(baseDir).find((entry) => /\.cer$/i.test(entry));
  return match ? path.join(baseDir, match) : "";
}

function parseSecurityList(output) {
  return String(output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function detectDeveloperIdIntermediateUrl(issuerLine) {
  return /\bOU=G2\b/.test(String(issuerLine || ""))
    ? DEVELOPER_ID_INTERMEDIATE_URLS.G2
    : DEVELOPER_ID_INTERMEDIATE_URLS.G1;
}

function resolveOfficialMacReleaseConfig(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const version = String(options.version || "").trim();
  if (!version) {
    throw new Error("Missing package version for official mac release.");
  }

  const env = options.env || process.env;
  const identity = String(
    options.identity
      || env.DEEPSEEK_TUI_MAC_SIGN_IDENTITY
      || 'Developer ID Application: chen He (3ZN7R3Z947)'
  ).trim();
  const appleApiKeyPath = path.resolve(
    options.appleApiKeyPath
      || env.APPLE_API_KEY_PATH
      || findAppleApiKeyPath(options.appKeyDir || env.DEEPSEEK_TUI_APPKEY_DIR || DEFAULT_APPKEY_DIR)
  );
  const appleApiKeyId = String(
    options.appleApiKeyId
      || env.APPLE_API_KEY_ID
      || detectAppleApiKeyId(appleApiKeyPath)
  ).trim();
  const appleApiIssuer = String(
    options.appleApiIssuer
      || env.APPLE_API_ISSUER
      || env.DEEPSEEK_TUI_APPLE_API_ISSUER
      || ""
  ).trim();
  const signingCertificatePath = path.resolve(
    options.signingCertificatePath
      || env.CSC_LINK
      || env.DEEPSEEK_TUI_CERT_P12_PATH
      || findSigningCertificatePath(options.appKeyDir || env.DEEPSEEK_TUI_APPKEY_DIR || DEFAULT_APPKEY_DIR)
  );
  const signingCertificateCerPath = path.resolve(
    options.signingCertificateCerPath
      || env.DEEPSEEK_TUI_CERT_CER_PATH
      || findSigningCertificateCerPath(options.appKeyDir || env.DEEPSEEK_TUI_APPKEY_DIR || DEFAULT_APPKEY_DIR)
  );
  const signingCertificatePassword = String(
    options.signingCertificatePassword
      || env.CSC_KEY_PASSWORD
      || env.DEEPSEEK_TUI_CERT_P12_PASSWORD
      || ""
  );
  const releaseKeychainPath = path.resolve(
    options.releaseKeychainPath
      || env.DEEPSEEK_TUI_MAC_SIGN_KEYCHAIN
      || path.join(os.homedir(), "Library/Keychains", DEFAULT_KEYCHAIN_NAME)
  );
  const releaseKeychainPassword = String(
    options.releaseKeychainPassword
      || env.DEEPSEEK_TUI_MAC_SIGN_KEYCHAIN_PASSWORD
      || DEFAULT_KEYCHAIN_PASSWORD
  ).trim();

  if (!identity) {
    throw new Error("Missing Developer ID signing identity.");
  }
  if (!appleApiKeyPath || !fs.existsSync(appleApiKeyPath)) {
    throw new Error(`Missing App Store Connect API key (.p8): ${appleApiKeyPath || "(empty path)"}`);
  }
  if (!appleApiKeyId) {
    throw new Error("Missing App Store Connect API key id.");
  }
  if (!appleApiIssuer) {
    throw new Error("Missing App Store Connect API issuer id.");
  }
  if (!signingCertificatePath || !fs.existsSync(signingCertificatePath)) {
    throw new Error(`Missing signing certificate (.p12): ${signingCertificatePath || "(empty path)"}`);
  }
  if (!signingCertificateCerPath || !fs.existsSync(signingCertificateCerPath)) {
    throw new Error(`Missing signing certificate (.cer): ${signingCertificateCerPath || "(empty path)"}`);
  }
  if (!signingCertificatePassword) {
    throw new Error("Missing signing certificate password (CSC_KEY_PASSWORD).");
  }
  if (!releaseKeychainPassword) {
    throw new Error("Missing release signing keychain password.");
  }

  const productName = String(options.productName || DEFAULT_PRODUCT_NAME);
  const arch = String(options.arch || DEFAULT_ARCH);
  const releaseDir = path.resolve(options.releaseDir || path.join(cwd, "release"));

  return {
    cwd,
    version,
    identity,
    productName,
    arch,
    releaseDir,
    appPath: path.join(releaseDir, `mac-${arch}`, `${productName}.app`),
    dmgPath: path.join(releaseDir, `${productName}-${version}-${arch}.dmg`),
    appleApi: {
      keyPath: appleApiKeyPath,
      keyId: appleApiKeyId,
      issuer: appleApiIssuer
    },
    signingCertificate: {
      p12Path: signingCertificatePath,
      cerPath: signingCertificateCerPath,
      p12Password: signingCertificatePassword
    },
    releaseKeychain: {
      path: releaseKeychainPath,
      password: releaseKeychainPassword
    }
  };
}

function buildDmgCodesignArgs(config) {
  return [
    "--force",
    "--keychain",
    config.releaseKeychain.path,
    "--sign",
    config.identity,
    "--timestamp",
    config.dmgPath
  ];
}

function buildNotarySubmitArgs(config) {
  return [
    "notarytool",
    "submit",
    config.dmgPath,
    "--key",
    config.appleApi.keyPath,
    "--key-id",
    config.appleApi.keyId,
    "--issuer",
    config.appleApi.issuer,
    "--wait",
    "--output-format",
    "json"
  ];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    env: options.env || process.env,
    maxBuffer: DEFAULT_MAX_BUFFER
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed\n${stderr || stdout || "Unknown error"}`);
  }
  return result;
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    env: options.env || process.env,
    maxBuffer: DEFAULT_MAX_BUFFER
  });
  return result;
}

function verifyArtifactExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function buildUserKeychainList(config, previousUserKeychains = []) {
  return uniqueStrings([
    config.releaseKeychain.path,
    ...previousUserKeychains,
    path.join(os.homedir(), "Library/Keychains/login.keychain-db"),
    "/Library/Keychains/System.keychain"
  ]);
}

function downloadIntermediateCertificate(config) {
  const issuerResult = run(
    "openssl",
    ["x509", "-in", config.signingCertificate.cerPath, "-inform", "DER", "-noout", "-issuer"],
    { cwd: config.cwd }
  );
  const issuerLine = String(issuerResult.stdout || "").trim();
  const url = detectDeveloperIdIntermediateUrl(issuerLine);
  const targetPath = path.join(os.tmpdir(), path.basename(new URL(url).pathname));

  run("curl", ["-fsSL", url, "-o", targetPath], { cwd: config.cwd });

  return {
    issuerLine,
    path: targetPath,
    url
  };
}

function setupSigningKeychain(config) {
  const previousResult = run("security", ["list-keychains", "-d", "user"]);
  const previousUserKeychains = parseSecurityList(previousResult.stdout);
  const keychainPath = config.releaseKeychain.path;
  const keychainPassword = config.releaseKeychain.password;
  const searchList = buildUserKeychainList(config, previousUserKeychains);
  const intermediateCertificate = downloadIntermediateCertificate(config);

  tryRun("security", ["delete-keychain", keychainPath], { cwd: config.cwd });
  run("security", ["create-keychain", "-p", keychainPassword, keychainPath], { cwd: config.cwd });
  run("security", ["set-keychain-settings", "-lut", "21600", keychainPath], { cwd: config.cwd });
  run("security", ["unlock-keychain", "-p", keychainPassword, keychainPath], { cwd: config.cwd });
  run("security", ["import", intermediateCertificate.path, "-k", keychainPath, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"], { cwd: config.cwd });
  run("security", ["import", config.signingCertificate.cerPath, "-k", keychainPath, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"], { cwd: config.cwd });
  run("security", ["import", config.signingCertificate.p12Path, "-k", keychainPath, "-P", config.signingCertificate.p12Password, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"], { cwd: config.cwd });
  run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychainPath], { cwd: config.cwd });
  run("security", ["list-keychains", "-d", "user", "-s", ...searchList], { cwd: config.cwd });
  run("security", ["find-identity", "-v", "-p", "codesigning", keychainPath], { cwd: config.cwd });

  return {
    previousUserKeychains,
    cleanup() {
      if (previousUserKeychains.length > 0) {
        run("security", ["list-keychains", "-d", "user", "-s", ...previousUserKeychains], { cwd: config.cwd });
      }
      tryRun("security", ["delete-keychain", keychainPath], { cwd: config.cwd });
    }
  };
}

function notarizeOfficialMacRelease(options = {}) {
  const config = resolveOfficialMacReleaseConfig(options);
  const keychainSession = setupSigningKeychain(config);
  const env = {
    ...process.env,
    DEEPSEEK_TUI_MAC_SIGN_IDENTITY: config.identity,
    DEEPSEEK_TUI_MAC_SIGN_KEYCHAIN: config.releaseKeychain.path
  };

  try {
    run("npm", ["run", "dist:mac"], { cwd: config.cwd, env });
    verifyArtifactExists(config.appPath, "signed app");
    verifyArtifactExists(config.dmgPath, "signed dmg");

    run("codesign", buildDmgCodesignArgs(config), { cwd: config.cwd });
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", config.appPath], { cwd: config.cwd });
    run("codesign", ["--verify", "--verbose=2", config.dmgPath], { cwd: config.cwd });

    const submit = run("xcrun", buildNotarySubmitArgs(config), { cwd: config.cwd });
    let notaryResult = null;
    try {
      notaryResult = JSON.parse(String(submit.stdout || "{}"));
    } catch {
      notaryResult = { raw: String(submit.stdout || "").trim() };
    }

    run("xcrun", ["stapler", "staple", config.dmgPath], { cwd: config.cwd });
    run("xcrun", ["stapler", "validate", config.dmgPath], { cwd: config.cwd });
    run("spctl", ["-a", "-vvv", "-t", "install", config.dmgPath], { cwd: config.cwd });
    run("hdiutil", ["verify", config.dmgPath], { cwd: config.cwd });

    return {
      config,
      notaryResult
    };
  } finally {
    keychainSession.cleanup();
  }
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const result = notarizeOfficialMacRelease({ version: packageJson.version });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildDmgCodesignArgs,
  buildNotarySubmitArgs,
  buildUserKeychainList,
  detectAppleApiKeyId,
  detectDeveloperIdIntermediateUrl,
  findAppleApiKeyPath,
  findSigningCertificateCerPath,
  findSigningCertificatePath,
  notarizeOfficialMacRelease,
  parseSecurityList,
  resolveOfficialMacReleaseConfig
};
