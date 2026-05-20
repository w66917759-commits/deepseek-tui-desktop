const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function loadTsModule(filePath, cache = new Map()) {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(__dirname, "..", filePath);
  const normalizedPath = path.normalize(absolutePath);
  if (cache.has(normalizedPath)) return cache.get(normalizedPath).exports;

  const source = fs.readFileSync(normalizedPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const module = { exports: {} };
  cache.set(normalizedPath, module);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const resolved = path.resolve(path.dirname(normalizedPath), specifier);
    for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, path.join(resolved, "index.ts")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return loadTsModule(candidate, cache);
      }
    }
    return require(specifier);
  };
  const fn = new Function("exports", "module", "require", outputText);
  fn(module.exports, module, localRequire);
  return module.exports;
}

module.exports = { loadTsModule };
