const Module = process.getBuiltinModule('module');
const original = Module._resolveFilename;
Module._resolveFilename = function(name, ...args) {
  return original.call(this, name === 'server-only' ? process.cwd() + '/node_modules/next/dist/compiled/server-only/empty.js' : name, ...args);
};
