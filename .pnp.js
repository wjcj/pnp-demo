#!/usr/bin/env node

/* eslint-disable max-len, flowtype/require-valid-file-annotation, flowtype/require-return-type */
/* global packageInformationStores, null, $$SETUP_STATIC_TABLES */

// Used for the resolveUnqualified part of the resolution (ie resolving folder/index.js & file extensions)
// Deconstructed so that they aren't affected by any fs monkeypatching occuring later during the execution
const {statSync, lstatSync, readlinkSync, readFileSync, existsSync, realpathSync} = require('fs');

const Module = require('module');
const path = require('path');
const StringDecoder = require('string_decoder');

const ignorePattern = null ? new RegExp(null) : null;

const pnpFile = path.resolve(__dirname, __filename);
const builtinModules = new Set(Module.builtinModules || Object.keys(process.binding('natives')));

const topLevelLocator = {name: null, reference: null};
const blacklistedLocator = {name: NaN, reference: NaN};

// Used for compatibility purposes - cf setupCompatibilityLayer
const patchedModules = [];
const fallbackLocators = [topLevelLocator];

// Matches backslashes of Windows paths
const backwardSlashRegExp = /\\/g;

// Matches if the path must point to a directory (ie ends with /)
const isDirRegExp = /\/$/;

// Matches if the path starts with a valid path qualifier (./, ../, /)
// eslint-disable-next-line no-unused-vars
const isStrictRegExp = /^\.{0,2}\//;

// Splits a require request into its components, or return null if the request is a file path
const pathRegExp = /^(?![a-zA-Z]:[\\\/]|\\\\|\.{0,2}(?:\/|$))((?:@[^\/]+\/)?[^\/]+)\/?(.*|)$/;

// Keep a reference around ("module" is a common name in this context, so better rename it to something more significant)
const pnpModule = module;

/**
 * Used to disable the resolution hooks (for when we want to fallback to the previous resolution - we then need
 * a way to "reset" the environment temporarily)
 */

let enableNativeHooks = true;

/**
 * Simple helper function that assign an error code to an error, so that it can more easily be caught and used
 * by third-parties.
 */

function makeError(code, message, data = {}) {
  const error = new Error(message);
  return Object.assign(error, {code, data});
}

/**
 * Ensures that the returned locator isn't a blacklisted one.
 *
 * Blacklisted packages are packages that cannot be used because their dependencies cannot be deduced. This only
 * happens with peer dependencies, which effectively have different sets of dependencies depending on their parents.
 *
 * In order to deambiguate those different sets of dependencies, the Yarn implementation of PnP will generate a
 * symlink for each combination of <package name>/<package version>/<dependent package> it will find, and will
 * blacklist the target of those symlinks. By doing this, we ensure that files loaded through a specific path
 * will always have the same set of dependencies, provided the symlinks are correctly preserved.
 *
 * Unfortunately, some tools do not preserve them, and when it happens PnP isn't able anymore to deduce the set of
 * dependencies based on the path of the file that makes the require calls. But since we've blacklisted those paths,
 * we're able to print a more helpful error message that points out that a third-party package is doing something
 * incompatible!
 */

// eslint-disable-next-line no-unused-vars
function blacklistCheck(locator) {
  if (locator === blacklistedLocator) {
    throw makeError(
      `BLACKLISTED`,
      [
        `A package has been resolved through a blacklisted path - this is usually caused by one of your tools calling`,
        `"realpath" on the return value of "require.resolve". Since the returned values use symlinks to disambiguate`,
        `peer dependencies, they must be passed untransformed to "require".`,
      ].join(` `)
    );
  }

  return locator;
}

let packageInformationStores = new Map([
  ["qs", new Map([
    ["6.10.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-qs-6.10.1-4931482fa8d647a5aab799c5271d2133b981fb6a-integrity/node_modules/qs/"),
      packageDependencies: new Map([
        ["side-channel", "1.0.4"],
        ["qs", "6.10.1"],
      ]),
    }],
  ])],
  ["side-channel", new Map([
    ["1.0.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-side-channel-1.0.4-efce5c8fdc104ee751b25c58d4290011fa5ea2cf-integrity/node_modules/side-channel/"),
      packageDependencies: new Map([
        ["call-bind", "1.0.2"],
        ["get-intrinsic", "1.1.1"],
        ["object-inspect", "1.10.3"],
        ["side-channel", "1.0.4"],
      ]),
    }],
  ])],
  ["call-bind", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-call-bind-1.0.2-b1d4e89e688119c3c9a903ad30abb2f6a919be3c-integrity/node_modules/call-bind/"),
      packageDependencies: new Map([
        ["function-bind", "1.1.1"],
        ["get-intrinsic", "1.1.1"],
        ["call-bind", "1.0.2"],
      ]),
    }],
  ])],
  ["function-bind", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-function-bind-1.1.1-a56899d3ea3c9bab874bb9773b7c5ede92f4895d-integrity/node_modules/function-bind/"),
      packageDependencies: new Map([
        ["function-bind", "1.1.1"],
      ]),
    }],
  ])],
  ["get-intrinsic", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-get-intrinsic-1.1.1-15f59f376f855c446963948f0d24cd3637b4abc6-integrity/node_modules/get-intrinsic/"),
      packageDependencies: new Map([
        ["function-bind", "1.1.1"],
        ["has", "1.0.3"],
        ["has-symbols", "1.0.2"],
        ["get-intrinsic", "1.1.1"],
      ]),
    }],
  ])],
  ["has", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-has-1.0.3-722d7cbfc1f6aa8241f16dd814e011e1f41e8796-integrity/node_modules/has/"),
      packageDependencies: new Map([
        ["function-bind", "1.1.1"],
        ["has", "1.0.3"],
      ]),
    }],
  ])],
  ["has-symbols", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-has-symbols-1.0.2-165d3070c00309752a1236a479331e3ac56f1423-integrity/node_modules/has-symbols/"),
      packageDependencies: new Map([
        ["has-symbols", "1.0.2"],
      ]),
    }],
  ])],
  ["object-inspect", new Map([
    ["1.10.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-object-inspect-1.10.3-c2aa7d2d09f50c99375704f7a0adf24c5782d369-integrity/node_modules/object-inspect/"),
      packageDependencies: new Map([
        ["object-inspect", "1.10.3"],
      ]),
    }],
  ])],
  ["jest", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-27.0.6-10517b2a628f0409087fbf473db44777d7a04505-integrity/node_modules/jest/"),
      packageDependencies: new Map([
        ["@jest/core", "pnp:e16659376c40eeb553199539f43f1f4a408bbc71"],
        ["import-local", "3.0.2"],
        ["jest-cli", "27.0.6"],
        ["jest", "27.0.6"],
      ]),
    }],
  ])],
  ["@jest/core", new Map([
    ["pnp:e16659376c40eeb553199539f43f1f4a408bbc71", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-e16659376c40eeb553199539f43f1f4a408bbc71/node_modules/@jest/core/"),
      packageDependencies: new Map([
        ["@jest/console", "27.0.6"],
        ["@jest/reporters", "27.0.6"],
        ["@jest/test-result", "27.0.6"],
        ["@jest/transform", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["ansi-escapes", "4.3.2"],
        ["chalk", "4.1.1"],
        ["emittery", "0.8.1"],
        ["exit", "0.1.2"],
        ["graceful-fs", "4.2.6"],
        ["jest-changed-files", "27.0.6"],
        ["jest-config", "pnp:03d96a41183e83878005f79a497dffac64cad5f8"],
        ["jest-haste-map", "27.0.6"],
        ["jest-message-util", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-resolve-dependencies", "27.0.6"],
        ["jest-runner", "27.0.6"],
        ["jest-runtime", "27.0.6"],
        ["jest-snapshot", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-validate", "27.0.6"],
        ["jest-watcher", "27.0.6"],
        ["micromatch", "4.0.4"],
        ["p-each-series", "2.2.0"],
        ["rimraf", "3.0.2"],
        ["slash", "3.0.0"],
        ["strip-ansi", "6.0.0"],
        ["@jest/core", "pnp:e16659376c40eeb553199539f43f1f4a408bbc71"],
      ]),
    }],
    ["pnp:009fc831e75ad92f6c70b337416a0184394e915b", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-009fc831e75ad92f6c70b337416a0184394e915b/node_modules/@jest/core/"),
      packageDependencies: new Map([
        ["@jest/console", "27.0.6"],
        ["@jest/reporters", "27.0.6"],
        ["@jest/test-result", "27.0.6"],
        ["@jest/transform", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["ansi-escapes", "4.3.2"],
        ["chalk", "4.1.1"],
        ["emittery", "0.8.1"],
        ["exit", "0.1.2"],
        ["graceful-fs", "4.2.6"],
        ["jest-changed-files", "27.0.6"],
        ["jest-config", "pnp:0f0e2a91a6379bbdf821c39c6146ea3908288fe2"],
        ["jest-haste-map", "27.0.6"],
        ["jest-message-util", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-resolve-dependencies", "27.0.6"],
        ["jest-runner", "27.0.6"],
        ["jest-runtime", "27.0.6"],
        ["jest-snapshot", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-validate", "27.0.6"],
        ["jest-watcher", "27.0.6"],
        ["micromatch", "4.0.4"],
        ["p-each-series", "2.2.0"],
        ["rimraf", "3.0.2"],
        ["slash", "3.0.0"],
        ["strip-ansi", "6.0.0"],
        ["@jest/core", "pnp:009fc831e75ad92f6c70b337416a0184394e915b"],
      ]),
    }],
  ])],
  ["@jest/console", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-console-27.0.6-3eb72ea80897495c3d73dd97aab7f26770e2260f-integrity/node_modules/@jest/console/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["chalk", "4.1.1"],
        ["jest-message-util", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["slash", "3.0.0"],
        ["@jest/console", "27.0.6"],
      ]),
    }],
  ])],
  ["@jest/types", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-types-27.0.6-9a992bc517e0c49f035938b8549719c2de40706b-integrity/node_modules/@jest/types/"),
      packageDependencies: new Map([
        ["@types/istanbul-lib-coverage", "2.0.3"],
        ["@types/istanbul-reports", "3.0.1"],
        ["@types/node", "16.3.1"],
        ["@types/yargs", "16.0.4"],
        ["chalk", "4.1.1"],
        ["@jest/types", "27.0.6"],
      ]),
    }],
  ])],
  ["@types/istanbul-lib-coverage", new Map([
    ["2.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-istanbul-lib-coverage-2.0.3-4ba8ddb720221f432e443bd5f9117fd22cfd4762-integrity/node_modules/@types/istanbul-lib-coverage/"),
      packageDependencies: new Map([
        ["@types/istanbul-lib-coverage", "2.0.3"],
      ]),
    }],
  ])],
  ["@types/istanbul-reports", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-istanbul-reports-3.0.1-9153fe98bba2bd565a63add9436d6f0d7f8468ff-integrity/node_modules/@types/istanbul-reports/"),
      packageDependencies: new Map([
        ["@types/istanbul-lib-report", "3.0.0"],
        ["@types/istanbul-reports", "3.0.1"],
      ]),
    }],
  ])],
  ["@types/istanbul-lib-report", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-istanbul-lib-report-3.0.0-c14c24f18ea8190c118ee7562b7ff99a36552686-integrity/node_modules/@types/istanbul-lib-report/"),
      packageDependencies: new Map([
        ["@types/istanbul-lib-coverage", "2.0.3"],
        ["@types/istanbul-lib-report", "3.0.0"],
      ]),
    }],
  ])],
  ["@types/node", new Map([
    ["16.3.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-node-16.3.1-24691fa2b0c3ec8c0d34bfcfd495edac5593ebb4-integrity/node_modules/@types/node/"),
      packageDependencies: new Map([
        ["@types/node", "16.3.1"],
      ]),
    }],
  ])],
  ["@types/yargs", new Map([
    ["16.0.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-yargs-16.0.4-26aad98dd2c2a38e421086ea9ad42b9e51642977-integrity/node_modules/@types/yargs/"),
      packageDependencies: new Map([
        ["@types/yargs-parser", "20.2.1"],
        ["@types/yargs", "16.0.4"],
      ]),
    }],
  ])],
  ["@types/yargs-parser", new Map([
    ["20.2.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-yargs-parser-20.2.1-3b9ce2489919d9e4fea439b76916abc34b2df129-integrity/node_modules/@types/yargs-parser/"),
      packageDependencies: new Map([
        ["@types/yargs-parser", "20.2.1"],
      ]),
    }],
  ])],
  ["chalk", new Map([
    ["4.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-chalk-4.1.1-c80b3fab28bf6371e6863325eee67e618b77e6ad-integrity/node_modules/chalk/"),
      packageDependencies: new Map([
        ["ansi-styles", "4.3.0"],
        ["supports-color", "7.2.0"],
        ["chalk", "4.1.1"],
      ]),
    }],
    ["2.4.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-chalk-2.4.2-cd42541677a54333cf541a49108c1432b44c9424-integrity/node_modules/chalk/"),
      packageDependencies: new Map([
        ["ansi-styles", "3.2.1"],
        ["escape-string-regexp", "1.0.5"],
        ["supports-color", "5.5.0"],
        ["chalk", "2.4.2"],
      ]),
    }],
  ])],
  ["ansi-styles", new Map([
    ["4.3.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-ansi-styles-4.3.0-edd803628ae71c04c85ae7a0906edad34b648937-integrity/node_modules/ansi-styles/"),
      packageDependencies: new Map([
        ["color-convert", "2.0.1"],
        ["ansi-styles", "4.3.0"],
      ]),
    }],
    ["3.2.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-ansi-styles-3.2.1-41fbb20243e50b12be0f04b8dedbf07520ce841d-integrity/node_modules/ansi-styles/"),
      packageDependencies: new Map([
        ["color-convert", "1.9.3"],
        ["ansi-styles", "3.2.1"],
      ]),
    }],
    ["5.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-ansi-styles-5.2.0-07449690ad45777d1924ac2abb2fc8895dba836b-integrity/node_modules/ansi-styles/"),
      packageDependencies: new Map([
        ["ansi-styles", "5.2.0"],
      ]),
    }],
  ])],
  ["color-convert", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-color-convert-2.0.1-72d3a68d598c9bdb3af2ad1e84f21d896abd4de3-integrity/node_modules/color-convert/"),
      packageDependencies: new Map([
        ["color-name", "1.1.4"],
        ["color-convert", "2.0.1"],
      ]),
    }],
    ["1.9.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-color-convert-1.9.3-bb71850690e1f136567de629d2d5471deda4c1e8-integrity/node_modules/color-convert/"),
      packageDependencies: new Map([
        ["color-name", "1.1.3"],
        ["color-convert", "1.9.3"],
      ]),
    }],
  ])],
  ["color-name", new Map([
    ["1.1.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-color-name-1.1.4-c2a09a87acbde69543de6f63fa3995c826c536a2-integrity/node_modules/color-name/"),
      packageDependencies: new Map([
        ["color-name", "1.1.4"],
      ]),
    }],
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-color-name-1.1.3-a7d0558bd89c42f795dd42328f740831ca53bc25-integrity/node_modules/color-name/"),
      packageDependencies: new Map([
        ["color-name", "1.1.3"],
      ]),
    }],
  ])],
  ["supports-color", new Map([
    ["7.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-supports-color-7.2.0-1b7dcdcb32b8138801b3e478ba6a51caa89648da-integrity/node_modules/supports-color/"),
      packageDependencies: new Map([
        ["has-flag", "4.0.0"],
        ["supports-color", "7.2.0"],
      ]),
    }],
    ["5.5.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-supports-color-5.5.0-e2e69a44ac8772f78a1ec0b35b689df6530efc8f-integrity/node_modules/supports-color/"),
      packageDependencies: new Map([
        ["has-flag", "3.0.0"],
        ["supports-color", "5.5.0"],
      ]),
    }],
    ["8.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-supports-color-8.1.1-cd6fc17e28500cff56c1b86c0a7fd4a54a73005c-integrity/node_modules/supports-color/"),
      packageDependencies: new Map([
        ["has-flag", "4.0.0"],
        ["supports-color", "8.1.1"],
      ]),
    }],
  ])],
  ["has-flag", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-has-flag-4.0.0-944771fd9c81c81265c4d6941860da06bb59479b-integrity/node_modules/has-flag/"),
      packageDependencies: new Map([
        ["has-flag", "4.0.0"],
      ]),
    }],
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-has-flag-3.0.0-b5d454dc2199ae225699f3467e5a07f3b955bafd-integrity/node_modules/has-flag/"),
      packageDependencies: new Map([
        ["has-flag", "3.0.0"],
      ]),
    }],
  ])],
  ["jest-message-util", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-message-util-27.0.6-158bcdf4785706492d164a39abca6a14da5ab8b5-integrity/node_modules/jest-message-util/"),
      packageDependencies: new Map([
        ["@babel/code-frame", "7.14.5"],
        ["@jest/types", "27.0.6"],
        ["@types/stack-utils", "2.0.1"],
        ["chalk", "4.1.1"],
        ["graceful-fs", "4.2.6"],
        ["micromatch", "4.0.4"],
        ["pretty-format", "27.0.6"],
        ["slash", "3.0.0"],
        ["stack-utils", "2.0.3"],
        ["jest-message-util", "27.0.6"],
      ]),
    }],
  ])],
  ["@babel/code-frame", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-code-frame-7.14.5-23b08d740e83f49c5e59945fbf1b43e80bbf4edb-integrity/node_modules/@babel/code-frame/"),
      packageDependencies: new Map([
        ["@babel/highlight", "7.14.5"],
        ["@babel/code-frame", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/highlight", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-highlight-7.14.5-6861a52f03966405001f6aa534a01a24d99e8cd9-integrity/node_modules/@babel/highlight/"),
      packageDependencies: new Map([
        ["@babel/helper-validator-identifier", "7.14.5"],
        ["chalk", "2.4.2"],
        ["js-tokens", "4.0.0"],
        ["@babel/highlight", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/helper-validator-identifier", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-validator-identifier-7.14.5-d0f0e277c512e0c938277faa85a3968c9a44c0e8-integrity/node_modules/@babel/helper-validator-identifier/"),
      packageDependencies: new Map([
        ["@babel/helper-validator-identifier", "7.14.5"],
      ]),
    }],
  ])],
  ["escape-string-regexp", new Map([
    ["1.0.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-escape-string-regexp-1.0.5-1b61c0562190a8dff6ae3bb2cf0200ca130b86d4-integrity/node_modules/escape-string-regexp/"),
      packageDependencies: new Map([
        ["escape-string-regexp", "1.0.5"],
      ]),
    }],
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-escape-string-regexp-2.0.0-a30304e99daa32e23b2fd20f51babd07cffca344-integrity/node_modules/escape-string-regexp/"),
      packageDependencies: new Map([
        ["escape-string-regexp", "2.0.0"],
      ]),
    }],
  ])],
  ["js-tokens", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-js-tokens-4.0.0-19203fb59991df98e3a287050d4647cdeaf32499-integrity/node_modules/js-tokens/"),
      packageDependencies: new Map([
        ["js-tokens", "4.0.0"],
      ]),
    }],
  ])],
  ["@types/stack-utils", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-stack-utils-2.0.1-20f18294f797f2209b5f65c8e3b5c8e8261d127c-integrity/node_modules/@types/stack-utils/"),
      packageDependencies: new Map([
        ["@types/stack-utils", "2.0.1"],
      ]),
    }],
  ])],
  ["graceful-fs", new Map([
    ["4.2.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-graceful-fs-4.2.6-ff040b2b0853b23c3d31027523706f1885d76bee-integrity/node_modules/graceful-fs/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.2.6"],
      ]),
    }],
  ])],
  ["micromatch", new Map([
    ["4.0.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-micromatch-4.0.4-896d519dfe9db25fce94ceb7a500919bf881ebf9-integrity/node_modules/micromatch/"),
      packageDependencies: new Map([
        ["braces", "3.0.2"],
        ["picomatch", "2.3.0"],
        ["micromatch", "4.0.4"],
      ]),
    }],
  ])],
  ["braces", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-braces-3.0.2-3454e1a462ee8d599e236df336cd9ea4f8afe107-integrity/node_modules/braces/"),
      packageDependencies: new Map([
        ["fill-range", "7.0.1"],
        ["braces", "3.0.2"],
      ]),
    }],
  ])],
  ["fill-range", new Map([
    ["7.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-fill-range-7.0.1-1919a6a7c75fe38b2c7c77e5198535da9acdda40-integrity/node_modules/fill-range/"),
      packageDependencies: new Map([
        ["to-regex-range", "5.0.1"],
        ["fill-range", "7.0.1"],
      ]),
    }],
  ])],
  ["to-regex-range", new Map([
    ["5.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-to-regex-range-5.0.1-1648c44aae7c8d988a326018ed72f5b4dd0392e4-integrity/node_modules/to-regex-range/"),
      packageDependencies: new Map([
        ["is-number", "7.0.0"],
        ["to-regex-range", "5.0.1"],
      ]),
    }],
  ])],
  ["is-number", new Map([
    ["7.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-is-number-7.0.0-7535345b896734d5f80c4d06c50955527a14f12b-integrity/node_modules/is-number/"),
      packageDependencies: new Map([
        ["is-number", "7.0.0"],
      ]),
    }],
  ])],
  ["picomatch", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-picomatch-2.3.0-f1f061de8f6a4bf022892e2d128234fb98302972-integrity/node_modules/picomatch/"),
      packageDependencies: new Map([
        ["picomatch", "2.3.0"],
      ]),
    }],
  ])],
  ["pretty-format", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-pretty-format-27.0.6-ab770c47b2c6f893a21aefc57b75da63ef49a11f-integrity/node_modules/pretty-format/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["ansi-regex", "5.0.0"],
        ["ansi-styles", "5.2.0"],
        ["react-is", "17.0.2"],
        ["pretty-format", "27.0.6"],
      ]),
    }],
  ])],
  ["ansi-regex", new Map([
    ["5.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-ansi-regex-5.0.0-388539f55179bf39339c81af30a654d69f87cb75-integrity/node_modules/ansi-regex/"),
      packageDependencies: new Map([
        ["ansi-regex", "5.0.0"],
      ]),
    }],
  ])],
  ["react-is", new Map([
    ["17.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-react-is-17.0.2-e691d4a8e9c789365655539ab372762b0efb54f0-integrity/node_modules/react-is/"),
      packageDependencies: new Map([
        ["react-is", "17.0.2"],
      ]),
    }],
  ])],
  ["slash", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-slash-3.0.0-6539be870c165adbd5240220dbe361f1bc4d4634-integrity/node_modules/slash/"),
      packageDependencies: new Map([
        ["slash", "3.0.0"],
      ]),
    }],
  ])],
  ["stack-utils", new Map([
    ["2.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-stack-utils-2.0.3-cd5f030126ff116b78ccb3c027fe302713b61277-integrity/node_modules/stack-utils/"),
      packageDependencies: new Map([
        ["escape-string-regexp", "2.0.0"],
        ["stack-utils", "2.0.3"],
      ]),
    }],
  ])],
  ["jest-util", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-util-27.0.6-e8e04eec159de2f4d5f57f795df9cdc091e50297-integrity/node_modules/jest-util/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["chalk", "4.1.1"],
        ["graceful-fs", "4.2.6"],
        ["is-ci", "3.0.0"],
        ["picomatch", "2.3.0"],
        ["jest-util", "27.0.6"],
      ]),
    }],
  ])],
  ["is-ci", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-is-ci-3.0.0-c7e7be3c9d8eef7d0fa144390bd1e4b88dc4c994-integrity/node_modules/is-ci/"),
      packageDependencies: new Map([
        ["ci-info", "3.2.0"],
        ["is-ci", "3.0.0"],
      ]),
    }],
  ])],
  ["ci-info", new Map([
    ["3.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-ci-info-3.2.0-2876cb948a498797b5236f0095bc057d0dca38b6-integrity/node_modules/ci-info/"),
      packageDependencies: new Map([
        ["ci-info", "3.2.0"],
      ]),
    }],
  ])],
  ["@jest/reporters", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-reporters-27.0.6-91e7f2d98c002ad5df94d5b5167c1eb0b9fd5b00-integrity/node_modules/@jest/reporters/"),
      packageDependencies: new Map([
        ["@bcoe/v8-coverage", "0.2.3"],
        ["@jest/console", "27.0.6"],
        ["@jest/test-result", "27.0.6"],
        ["@jest/transform", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["chalk", "4.1.1"],
        ["collect-v8-coverage", "1.0.1"],
        ["exit", "0.1.2"],
        ["glob", "7.1.7"],
        ["graceful-fs", "4.2.6"],
        ["istanbul-lib-coverage", "3.0.0"],
        ["istanbul-lib-instrument", "4.0.3"],
        ["istanbul-lib-report", "3.0.0"],
        ["istanbul-lib-source-maps", "4.0.0"],
        ["istanbul-reports", "3.0.2"],
        ["jest-haste-map", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-worker", "27.0.6"],
        ["slash", "3.0.0"],
        ["source-map", "0.6.1"],
        ["string-length", "4.0.2"],
        ["terminal-link", "2.1.1"],
        ["v8-to-istanbul", "8.0.0"],
        ["@jest/reporters", "27.0.6"],
      ]),
    }],
  ])],
  ["@bcoe/v8-coverage", new Map([
    ["0.2.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@bcoe-v8-coverage-0.2.3-75a2e8b51cb758a7553d6804a5932d7aace75c39-integrity/node_modules/@bcoe/v8-coverage/"),
      packageDependencies: new Map([
        ["@bcoe/v8-coverage", "0.2.3"],
      ]),
    }],
  ])],
  ["@jest/test-result", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-test-result-27.0.6-3fa42015a14e4fdede6acd042ce98c7f36627051-integrity/node_modules/@jest/test-result/"),
      packageDependencies: new Map([
        ["@jest/console", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/istanbul-lib-coverage", "2.0.3"],
        ["collect-v8-coverage", "1.0.1"],
        ["@jest/test-result", "27.0.6"],
      ]),
    }],
  ])],
  ["collect-v8-coverage", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-collect-v8-coverage-1.0.1-cc2c8e94fc18bbdffe64d6534570c8a673b27f59-integrity/node_modules/collect-v8-coverage/"),
      packageDependencies: new Map([
        ["collect-v8-coverage", "1.0.1"],
      ]),
    }],
  ])],
  ["@jest/transform", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-transform-27.0.6-189ad7107413208f7600f4719f81dd2f7278cc95-integrity/node_modules/@jest/transform/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@jest/types", "27.0.6"],
        ["babel-plugin-istanbul", "6.0.0"],
        ["chalk", "4.1.1"],
        ["convert-source-map", "1.8.0"],
        ["fast-json-stable-stringify", "2.1.0"],
        ["graceful-fs", "4.2.6"],
        ["jest-haste-map", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["micromatch", "4.0.4"],
        ["pirates", "4.0.1"],
        ["slash", "3.0.0"],
        ["source-map", "0.6.1"],
        ["write-file-atomic", "3.0.3"],
        ["@jest/transform", "27.0.6"],
      ]),
    }],
  ])],
  ["@babel/core", new Map([
    ["7.14.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-core-7.14.6-e0814ec1a950032ff16c13a2721de39a8416fcab-integrity/node_modules/@babel/core/"),
      packageDependencies: new Map([
        ["@babel/code-frame", "7.14.5"],
        ["@babel/generator", "7.14.5"],
        ["@babel/helper-compilation-targets", "7.14.5"],
        ["@babel/helper-module-transforms", "7.14.5"],
        ["@babel/helpers", "7.14.6"],
        ["@babel/parser", "7.14.7"],
        ["@babel/template", "7.14.5"],
        ["@babel/traverse", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["convert-source-map", "1.8.0"],
        ["debug", "4.3.2"],
        ["gensync", "1.0.0-beta.2"],
        ["json5", "2.2.0"],
        ["semver", "6.3.0"],
        ["source-map", "0.5.7"],
        ["@babel/core", "7.14.6"],
      ]),
    }],
  ])],
  ["@babel/generator", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-generator-7.14.5-848d7b9f031caca9d0cd0af01b063f226f52d785-integrity/node_modules/@babel/generator/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["jsesc", "2.5.2"],
        ["source-map", "0.5.7"],
        ["@babel/generator", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/types", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-types-7.14.5-3bb997ba829a2104cedb20689c4a5b8121d383ff-integrity/node_modules/@babel/types/"),
      packageDependencies: new Map([
        ["@babel/helper-validator-identifier", "7.14.5"],
        ["to-fast-properties", "2.0.0"],
        ["@babel/types", "7.14.5"],
      ]),
    }],
  ])],
  ["to-fast-properties", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-to-fast-properties-2.0.0-dc5e698cbd079265bc73e0377681a4e4e83f616e-integrity/node_modules/to-fast-properties/"),
      packageDependencies: new Map([
        ["to-fast-properties", "2.0.0"],
      ]),
    }],
  ])],
  ["jsesc", new Map([
    ["2.5.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jsesc-2.5.2-80564d2e483dacf6e8ef209650a67df3f0c283a4-integrity/node_modules/jsesc/"),
      packageDependencies: new Map([
        ["jsesc", "2.5.2"],
      ]),
    }],
  ])],
  ["source-map", new Map([
    ["0.5.7", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-source-map-0.5.7-8a039d2d1021d22d1ea14c80d8ea468ba2ef3fcc-integrity/node_modules/source-map/"),
      packageDependencies: new Map([
        ["source-map", "0.5.7"],
      ]),
    }],
    ["0.6.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-source-map-0.6.1-74722af32e9614e9c287a8d0bbde48b5e2f1a263-integrity/node_modules/source-map/"),
      packageDependencies: new Map([
        ["source-map", "0.6.1"],
      ]),
    }],
    ["0.7.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-source-map-0.7.3-5302f8169031735226544092e64981f751750383-integrity/node_modules/source-map/"),
      packageDependencies: new Map([
        ["source-map", "0.7.3"],
      ]),
    }],
  ])],
  ["@babel/helper-compilation-targets", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-compilation-targets-7.14.5-7a99c5d0967911e972fe2c3411f7d5b498498ecf-integrity/node_modules/@babel/helper-compilation-targets/"),
      packageDependencies: new Map([
        ["@babel/compat-data", "7.14.7"],
        ["@babel/helper-validator-option", "7.14.5"],
        ["browserslist", "4.16.6"],
        ["semver", "6.3.0"],
        ["@babel/helper-compilation-targets", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/compat-data", new Map([
    ["7.14.7", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-compat-data-7.14.7-7b047d7a3a89a67d2258dc61f604f098f1bc7e08-integrity/node_modules/@babel/compat-data/"),
      packageDependencies: new Map([
        ["@babel/compat-data", "7.14.7"],
      ]),
    }],
  ])],
  ["@babel/helper-validator-option", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-validator-option-7.14.5-6e72a1fff18d5dfcb878e1e62f1a021c4b72d5a3-integrity/node_modules/@babel/helper-validator-option/"),
      packageDependencies: new Map([
        ["@babel/helper-validator-option", "7.14.5"],
      ]),
    }],
  ])],
  ["browserslist", new Map([
    ["4.16.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-browserslist-4.16.6-d7901277a5a88e554ed305b183ec9b0c08f66fa2-integrity/node_modules/browserslist/"),
      packageDependencies: new Map([
        ["caniuse-lite", "1.0.30001243"],
        ["colorette", "1.2.2"],
        ["electron-to-chromium", "1.3.772"],
        ["escalade", "3.1.1"],
        ["node-releases", "1.1.73"],
        ["browserslist", "4.16.6"],
      ]),
    }],
  ])],
  ["caniuse-lite", new Map([
    ["1.0.30001243", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-caniuse-lite-1.0.30001243-d9250155c91e872186671c523f3ae50cfc94a3aa-integrity/node_modules/caniuse-lite/"),
      packageDependencies: new Map([
        ["caniuse-lite", "1.0.30001243"],
      ]),
    }],
  ])],
  ["colorette", new Map([
    ["1.2.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-colorette-1.2.2-cbcc79d5e99caea2dbf10eb3a26fd8b3e6acfa94-integrity/node_modules/colorette/"),
      packageDependencies: new Map([
        ["colorette", "1.2.2"],
      ]),
    }],
  ])],
  ["electron-to-chromium", new Map([
    ["1.3.772", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-electron-to-chromium-1.3.772-fd1ed39f9f3149f62f581734e4f026e600369479-integrity/node_modules/electron-to-chromium/"),
      packageDependencies: new Map([
        ["electron-to-chromium", "1.3.772"],
      ]),
    }],
  ])],
  ["escalade", new Map([
    ["3.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-escalade-3.1.1-d8cfdc7000965c5a0174b4a82eaa5c0552742e40-integrity/node_modules/escalade/"),
      packageDependencies: new Map([
        ["escalade", "3.1.1"],
      ]),
    }],
  ])],
  ["node-releases", new Map([
    ["1.1.73", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-node-releases-1.1.73-dd4e81ddd5277ff846b80b52bb40c49edf7a7b20-integrity/node_modules/node-releases/"),
      packageDependencies: new Map([
        ["node-releases", "1.1.73"],
      ]),
    }],
  ])],
  ["semver", new Map([
    ["6.3.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-semver-6.3.0-ee0a64c8af5e8ceea67687b133761e1becbd1d3d-integrity/node_modules/semver/"),
      packageDependencies: new Map([
        ["semver", "6.3.0"],
      ]),
    }],
    ["7.3.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-semver-7.3.5-0b621c879348d8998e4b0e4be94b3f12e6018ef7-integrity/node_modules/semver/"),
      packageDependencies: new Map([
        ["lru-cache", "6.0.0"],
        ["semver", "7.3.5"],
      ]),
    }],
  ])],
  ["@babel/helper-module-transforms", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-module-transforms-7.14.5-7de42f10d789b423eb902ebd24031ca77cb1e10e-integrity/node_modules/@babel/helper-module-transforms/"),
      packageDependencies: new Map([
        ["@babel/helper-module-imports", "7.14.5"],
        ["@babel/helper-replace-supers", "7.14.5"],
        ["@babel/helper-simple-access", "7.14.5"],
        ["@babel/helper-split-export-declaration", "7.14.5"],
        ["@babel/helper-validator-identifier", "7.14.5"],
        ["@babel/template", "7.14.5"],
        ["@babel/traverse", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["@babel/helper-module-transforms", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/helper-module-imports", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-module-imports-7.14.5-6d1a44df6a38c957aa7c312da076429f11b422f3-integrity/node_modules/@babel/helper-module-imports/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@babel/helper-module-imports", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/helper-replace-supers", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-replace-supers-7.14.5-0ecc0b03c41cd567b4024ea016134c28414abb94-integrity/node_modules/@babel/helper-replace-supers/"),
      packageDependencies: new Map([
        ["@babel/helper-member-expression-to-functions", "7.14.7"],
        ["@babel/helper-optimise-call-expression", "7.14.5"],
        ["@babel/traverse", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["@babel/helper-replace-supers", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/helper-member-expression-to-functions", new Map([
    ["7.14.7", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-member-expression-to-functions-7.14.7-97e56244beb94211fe277bd818e3a329c66f7970-integrity/node_modules/@babel/helper-member-expression-to-functions/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@babel/helper-member-expression-to-functions", "7.14.7"],
      ]),
    }],
  ])],
  ["@babel/helper-optimise-call-expression", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-optimise-call-expression-7.14.5-f27395a8619e0665b3f0364cddb41c25d71b499c-integrity/node_modules/@babel/helper-optimise-call-expression/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@babel/helper-optimise-call-expression", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/traverse", new Map([
    ["7.14.7", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-traverse-7.14.7-64007c9774cfdc3abd23b0780bc18a3ce3631753-integrity/node_modules/@babel/traverse/"),
      packageDependencies: new Map([
        ["@babel/code-frame", "7.14.5"],
        ["@babel/generator", "7.14.5"],
        ["@babel/helper-function-name", "7.14.5"],
        ["@babel/helper-hoist-variables", "7.14.5"],
        ["@babel/helper-split-export-declaration", "7.14.5"],
        ["@babel/parser", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["debug", "4.3.2"],
        ["globals", "11.12.0"],
        ["@babel/traverse", "7.14.7"],
      ]),
    }],
  ])],
  ["@babel/helper-function-name", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-function-name-7.14.5-89e2c474972f15d8e233b52ee8c480e2cfcd50c4-integrity/node_modules/@babel/helper-function-name/"),
      packageDependencies: new Map([
        ["@babel/helper-get-function-arity", "7.14.5"],
        ["@babel/template", "7.14.5"],
        ["@babel/types", "7.14.5"],
        ["@babel/helper-function-name", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/helper-get-function-arity", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-get-function-arity-7.14.5-25fbfa579b0937eee1f3b805ece4ce398c431815-integrity/node_modules/@babel/helper-get-function-arity/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@babel/helper-get-function-arity", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/template", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-template-7.14.5-a9bc9d8b33354ff6e55a9c60d1109200a68974f4-integrity/node_modules/@babel/template/"),
      packageDependencies: new Map([
        ["@babel/code-frame", "7.14.5"],
        ["@babel/parser", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["@babel/template", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/parser", new Map([
    ["7.14.7", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-parser-7.14.7-6099720c8839ca865a2637e6c85852ead0bdb595-integrity/node_modules/@babel/parser/"),
      packageDependencies: new Map([
        ["@babel/parser", "7.14.7"],
      ]),
    }],
  ])],
  ["@babel/helper-hoist-variables", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-hoist-variables-7.14.5-e0dd27c33a78e577d7c8884916a3e7ef1f7c7f8d-integrity/node_modules/@babel/helper-hoist-variables/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@babel/helper-hoist-variables", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/helper-split-export-declaration", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-split-export-declaration-7.14.5-22b23a54ef51c2b7605d851930c1976dd0bc693a-integrity/node_modules/@babel/helper-split-export-declaration/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@babel/helper-split-export-declaration", "7.14.5"],
      ]),
    }],
  ])],
  ["debug", new Map([
    ["4.3.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-debug-4.3.2-f0a49c18ac8779e31d4a0c6029dfb76873c7428b-integrity/node_modules/debug/"),
      packageDependencies: new Map([
        ["ms", "2.1.2"],
        ["debug", "4.3.2"],
      ]),
    }],
  ])],
  ["ms", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-ms-2.1.2-d09d1f357b443f493382a8eb3ccd183872ae6009-integrity/node_modules/ms/"),
      packageDependencies: new Map([
        ["ms", "2.1.2"],
      ]),
    }],
  ])],
  ["globals", new Map([
    ["11.12.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-globals-11.12.0-ab8795338868a0babd8525758018c2a7eb95c42e-integrity/node_modules/globals/"),
      packageDependencies: new Map([
        ["globals", "11.12.0"],
      ]),
    }],
  ])],
  ["@babel/helper-simple-access", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-simple-access-7.14.5-66ea85cf53ba0b4e588ba77fc813f53abcaa41c4-integrity/node_modules/@babel/helper-simple-access/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@babel/helper-simple-access", "7.14.5"],
      ]),
    }],
  ])],
  ["@babel/helpers", new Map([
    ["7.14.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helpers-7.14.6-5b58306b95f1b47e2a0199434fa8658fa6c21635-integrity/node_modules/@babel/helpers/"),
      packageDependencies: new Map([
        ["@babel/template", "7.14.5"],
        ["@babel/traverse", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["@babel/helpers", "7.14.6"],
      ]),
    }],
  ])],
  ["convert-source-map", new Map([
    ["1.8.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-convert-source-map-1.8.0-f3373c32d21b4d780dd8004514684fb791ca4369-integrity/node_modules/convert-source-map/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
        ["convert-source-map", "1.8.0"],
      ]),
    }],
  ])],
  ["safe-buffer", new Map([
    ["5.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-safe-buffer-5.1.2-991ec69d296e0313747d59bdfd2b745c35f8828d-integrity/node_modules/safe-buffer/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
      ]),
    }],
  ])],
  ["gensync", new Map([
    ["1.0.0-beta.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-gensync-1.0.0-beta.2-32a6ee76c3d7f52d46b2b1ae5d93fea8580a25e0-integrity/node_modules/gensync/"),
      packageDependencies: new Map([
        ["gensync", "1.0.0-beta.2"],
      ]),
    }],
  ])],
  ["json5", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-json5-2.2.0-2dfefe720c6ba525d9ebd909950f0515316c89a3-integrity/node_modules/json5/"),
      packageDependencies: new Map([
        ["minimist", "1.2.5"],
        ["json5", "2.2.0"],
      ]),
    }],
  ])],
  ["minimist", new Map([
    ["1.2.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-minimist-1.2.5-67d66014b66a6a8aaa0c083c5fd58df4e4e97602-integrity/node_modules/minimist/"),
      packageDependencies: new Map([
        ["minimist", "1.2.5"],
      ]),
    }],
  ])],
  ["babel-plugin-istanbul", new Map([
    ["6.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-babel-plugin-istanbul-6.0.0-e159ccdc9af95e0b570c75b4573b7c34d671d765-integrity/node_modules/babel-plugin-istanbul/"),
      packageDependencies: new Map([
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@istanbuljs/load-nyc-config", "1.1.0"],
        ["@istanbuljs/schema", "0.1.3"],
        ["istanbul-lib-instrument", "4.0.3"],
        ["test-exclude", "6.0.0"],
        ["babel-plugin-istanbul", "6.0.0"],
      ]),
    }],
  ])],
  ["@babel/helper-plugin-utils", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-helper-plugin-utils-7.14.5-5ac822ce97eec46741ab70a517971e443a70c5a9-integrity/node_modules/@babel/helper-plugin-utils/"),
      packageDependencies: new Map([
        ["@babel/helper-plugin-utils", "7.14.5"],
      ]),
    }],
  ])],
  ["@istanbuljs/load-nyc-config", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@istanbuljs-load-nyc-config-1.1.0-fd3db1d59ecf7cf121e80650bb86712f9b55eced-integrity/node_modules/@istanbuljs/load-nyc-config/"),
      packageDependencies: new Map([
        ["camelcase", "5.3.1"],
        ["find-up", "4.1.0"],
        ["get-package-type", "0.1.0"],
        ["js-yaml", "3.14.1"],
        ["resolve-from", "5.0.0"],
        ["@istanbuljs/load-nyc-config", "1.1.0"],
      ]),
    }],
  ])],
  ["camelcase", new Map([
    ["5.3.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-camelcase-5.3.1-e3c9b31569e106811df242f715725a1f4c494320-integrity/node_modules/camelcase/"),
      packageDependencies: new Map([
        ["camelcase", "5.3.1"],
      ]),
    }],
    ["6.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-camelcase-6.2.0-924af881c9d525ac9d87f40d964e5cea982a1809-integrity/node_modules/camelcase/"),
      packageDependencies: new Map([
        ["camelcase", "6.2.0"],
      ]),
    }],
  ])],
  ["find-up", new Map([
    ["4.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-find-up-4.1.0-97afe7d6cdc0bc5928584b7c8d7b16e8a9aa5d19-integrity/node_modules/find-up/"),
      packageDependencies: new Map([
        ["locate-path", "5.0.0"],
        ["path-exists", "4.0.0"],
        ["find-up", "4.1.0"],
      ]),
    }],
  ])],
  ["locate-path", new Map([
    ["5.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-locate-path-5.0.0-1afba396afd676a6d42504d0a67a3a7eb9f62aa0-integrity/node_modules/locate-path/"),
      packageDependencies: new Map([
        ["p-locate", "4.1.0"],
        ["locate-path", "5.0.0"],
      ]),
    }],
  ])],
  ["p-locate", new Map([
    ["4.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-p-locate-4.1.0-a3428bb7088b3a60292f66919278b7c297ad4f07-integrity/node_modules/p-locate/"),
      packageDependencies: new Map([
        ["p-limit", "2.3.0"],
        ["p-locate", "4.1.0"],
      ]),
    }],
  ])],
  ["p-limit", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-p-limit-2.3.0-3dd33c647a214fdfffd835933eb086da0dc21db1-integrity/node_modules/p-limit/"),
      packageDependencies: new Map([
        ["p-try", "2.2.0"],
        ["p-limit", "2.3.0"],
      ]),
    }],
  ])],
  ["p-try", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-p-try-2.2.0-cb2868540e313d61de58fafbe35ce9004d5540e6-integrity/node_modules/p-try/"),
      packageDependencies: new Map([
        ["p-try", "2.2.0"],
      ]),
    }],
  ])],
  ["path-exists", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-path-exists-4.0.0-513bdbe2d3b95d7762e8c1137efa195c6c61b5b3-integrity/node_modules/path-exists/"),
      packageDependencies: new Map([
        ["path-exists", "4.0.0"],
      ]),
    }],
  ])],
  ["get-package-type", new Map([
    ["0.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-get-package-type-0.1.0-8de2d803cff44df3bc6c456e6668b36c3926e11a-integrity/node_modules/get-package-type/"),
      packageDependencies: new Map([
        ["get-package-type", "0.1.0"],
      ]),
    }],
  ])],
  ["js-yaml", new Map([
    ["3.14.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-js-yaml-3.14.1-dae812fdb3825fa306609a8717383c50c36a0537-integrity/node_modules/js-yaml/"),
      packageDependencies: new Map([
        ["argparse", "1.0.10"],
        ["esprima", "4.0.1"],
        ["js-yaml", "3.14.1"],
      ]),
    }],
  ])],
  ["argparse", new Map([
    ["1.0.10", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-argparse-1.0.10-bcd6791ea5ae09725e17e5ad988134cd40b3d911-integrity/node_modules/argparse/"),
      packageDependencies: new Map([
        ["sprintf-js", "1.0.3"],
        ["argparse", "1.0.10"],
      ]),
    }],
  ])],
  ["sprintf-js", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-sprintf-js-1.0.3-04e6926f662895354f3dd015203633b857297e2c-integrity/node_modules/sprintf-js/"),
      packageDependencies: new Map([
        ["sprintf-js", "1.0.3"],
      ]),
    }],
  ])],
  ["esprima", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-esprima-4.0.1-13b04cdb3e6c5d19df91ab6987a8695619b0aa71-integrity/node_modules/esprima/"),
      packageDependencies: new Map([
        ["esprima", "4.0.1"],
      ]),
    }],
  ])],
  ["resolve-from", new Map([
    ["5.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-resolve-from-5.0.0-c35225843df8f776df21c57557bc087e9dfdfc69-integrity/node_modules/resolve-from/"),
      packageDependencies: new Map([
        ["resolve-from", "5.0.0"],
      ]),
    }],
  ])],
  ["@istanbuljs/schema", new Map([
    ["0.1.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@istanbuljs-schema-0.1.3-e45e384e4b8ec16bce2fd903af78450f6bf7ec98-integrity/node_modules/@istanbuljs/schema/"),
      packageDependencies: new Map([
        ["@istanbuljs/schema", "0.1.3"],
      ]),
    }],
  ])],
  ["istanbul-lib-instrument", new Map([
    ["4.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-istanbul-lib-instrument-4.0.3-873c6fff897450118222774696a3f28902d77c1d-integrity/node_modules/istanbul-lib-instrument/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@istanbuljs/schema", "0.1.3"],
        ["istanbul-lib-coverage", "3.0.0"],
        ["semver", "6.3.0"],
        ["istanbul-lib-instrument", "4.0.3"],
      ]),
    }],
  ])],
  ["istanbul-lib-coverage", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-istanbul-lib-coverage-3.0.0-f5944a37c70b550b02a78a5c3b2055b280cec8ec-integrity/node_modules/istanbul-lib-coverage/"),
      packageDependencies: new Map([
        ["istanbul-lib-coverage", "3.0.0"],
      ]),
    }],
  ])],
  ["test-exclude", new Map([
    ["6.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-test-exclude-6.0.0-04a8698661d805ea6fa293b6cb9e63ac044ef15e-integrity/node_modules/test-exclude/"),
      packageDependencies: new Map([
        ["@istanbuljs/schema", "0.1.3"],
        ["glob", "7.1.7"],
        ["minimatch", "3.0.4"],
        ["test-exclude", "6.0.0"],
      ]),
    }],
  ])],
  ["glob", new Map([
    ["7.1.7", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-glob-7.1.7-3b193e9233f01d42d0b3f78294bbeeb418f94a90-integrity/node_modules/glob/"),
      packageDependencies: new Map([
        ["fs.realpath", "1.0.0"],
        ["inflight", "1.0.6"],
        ["inherits", "2.0.4"],
        ["minimatch", "3.0.4"],
        ["once", "1.4.0"],
        ["path-is-absolute", "1.0.1"],
        ["glob", "7.1.7"],
      ]),
    }],
  ])],
  ["fs.realpath", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-fs-realpath-1.0.0-1504ad2523158caa40db4a2787cb01411994ea4f-integrity/node_modules/fs.realpath/"),
      packageDependencies: new Map([
        ["fs.realpath", "1.0.0"],
      ]),
    }],
  ])],
  ["inflight", new Map([
    ["1.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-inflight-1.0.6-49bd6331d7d02d0c09bc910a1075ba8165b56df9-integrity/node_modules/inflight/"),
      packageDependencies: new Map([
        ["once", "1.4.0"],
        ["wrappy", "1.0.2"],
        ["inflight", "1.0.6"],
      ]),
    }],
  ])],
  ["once", new Map([
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-once-1.4.0-583b1aa775961d4b113ac17d9c50baef9dd76bd1-integrity/node_modules/once/"),
      packageDependencies: new Map([
        ["wrappy", "1.0.2"],
        ["once", "1.4.0"],
      ]),
    }],
  ])],
  ["wrappy", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-wrappy-1.0.2-b5243d8f3ec1aa35f1364605bc0d1036e30ab69f-integrity/node_modules/wrappy/"),
      packageDependencies: new Map([
        ["wrappy", "1.0.2"],
      ]),
    }],
  ])],
  ["inherits", new Map([
    ["2.0.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-inherits-2.0.4-0fa2c64f932917c3433a0ded55363aae37416b7c-integrity/node_modules/inherits/"),
      packageDependencies: new Map([
        ["inherits", "2.0.4"],
      ]),
    }],
  ])],
  ["minimatch", new Map([
    ["3.0.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-minimatch-3.0.4-5166e286457f03306064be5497e8dbb0c3d32083-integrity/node_modules/minimatch/"),
      packageDependencies: new Map([
        ["brace-expansion", "1.1.11"],
        ["minimatch", "3.0.4"],
      ]),
    }],
  ])],
  ["brace-expansion", new Map([
    ["1.1.11", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-brace-expansion-1.1.11-3c7fcbf529d87226f3d2f52b966ff5271eb441dd-integrity/node_modules/brace-expansion/"),
      packageDependencies: new Map([
        ["balanced-match", "1.0.2"],
        ["concat-map", "0.0.1"],
        ["brace-expansion", "1.1.11"],
      ]),
    }],
  ])],
  ["balanced-match", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-balanced-match-1.0.2-e83e3a7e3f300b34cb9d87f615fa0cbf357690ee-integrity/node_modules/balanced-match/"),
      packageDependencies: new Map([
        ["balanced-match", "1.0.2"],
      ]),
    }],
  ])],
  ["concat-map", new Map([
    ["0.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-concat-map-0.0.1-d8a96bd77fd68df7793a73036a3ba0d5405d477b-integrity/node_modules/concat-map/"),
      packageDependencies: new Map([
        ["concat-map", "0.0.1"],
      ]),
    }],
  ])],
  ["path-is-absolute", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-path-is-absolute-1.0.1-174b9268735534ffbc7ace6bf53a5a9e1b5c5f5f-integrity/node_modules/path-is-absolute/"),
      packageDependencies: new Map([
        ["path-is-absolute", "1.0.1"],
      ]),
    }],
  ])],
  ["fast-json-stable-stringify", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-fast-json-stable-stringify-2.1.0-874bf69c6f404c2b5d99c481341399fd55892633-integrity/node_modules/fast-json-stable-stringify/"),
      packageDependencies: new Map([
        ["fast-json-stable-stringify", "2.1.0"],
      ]),
    }],
  ])],
  ["jest-haste-map", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-haste-map-27.0.6-4683a4e68f6ecaa74231679dca237279562c8dc7-integrity/node_modules/jest-haste-map/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["@types/graceful-fs", "4.1.5"],
        ["@types/node", "16.3.1"],
        ["anymatch", "3.1.2"],
        ["fb-watchman", "2.0.1"],
        ["graceful-fs", "4.2.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-serializer", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-worker", "27.0.6"],
        ["micromatch", "4.0.4"],
        ["walker", "1.0.7"],
        ["fsevents", "2.3.2"],
        ["jest-haste-map", "27.0.6"],
      ]),
    }],
  ])],
  ["@types/graceful-fs", new Map([
    ["4.1.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-graceful-fs-4.1.5-21ffba0d98da4350db64891f92a9e5db3cdb4e15-integrity/node_modules/@types/graceful-fs/"),
      packageDependencies: new Map([
        ["@types/node", "16.3.1"],
        ["@types/graceful-fs", "4.1.5"],
      ]),
    }],
  ])],
  ["anymatch", new Map([
    ["3.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-anymatch-3.1.2-c0557c096af32f106198f4f4e2a383537e378716-integrity/node_modules/anymatch/"),
      packageDependencies: new Map([
        ["normalize-path", "3.0.0"],
        ["picomatch", "2.3.0"],
        ["anymatch", "3.1.2"],
      ]),
    }],
  ])],
  ["normalize-path", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-normalize-path-3.0.0-0dcd69ff23a1c9b11fd0978316644a0388216a65-integrity/node_modules/normalize-path/"),
      packageDependencies: new Map([
        ["normalize-path", "3.0.0"],
      ]),
    }],
  ])],
  ["fb-watchman", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-fb-watchman-2.0.1-fc84fb39d2709cf3ff6d743706157bb5708a8a85-integrity/node_modules/fb-watchman/"),
      packageDependencies: new Map([
        ["bser", "2.1.1"],
        ["fb-watchman", "2.0.1"],
      ]),
    }],
  ])],
  ["bser", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-bser-2.1.1-e6787da20ece9d07998533cfd9de6f5c38f4bc05-integrity/node_modules/bser/"),
      packageDependencies: new Map([
        ["node-int64", "0.4.0"],
        ["bser", "2.1.1"],
      ]),
    }],
  ])],
  ["node-int64", new Map([
    ["0.4.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-node-int64-0.4.0-87a9065cdb355d3182d8f94ce11188b825c68a3b-integrity/node_modules/node-int64/"),
      packageDependencies: new Map([
        ["node-int64", "0.4.0"],
      ]),
    }],
  ])],
  ["jest-regex-util", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-regex-util-27.0.6-02e112082935ae949ce5d13b2675db3d8c87d9c5-integrity/node_modules/jest-regex-util/"),
      packageDependencies: new Map([
        ["jest-regex-util", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-serializer", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-serializer-27.0.6-93a6c74e0132b81a2d54623251c46c498bb5bec1-integrity/node_modules/jest-serializer/"),
      packageDependencies: new Map([
        ["@types/node", "16.3.1"],
        ["graceful-fs", "4.2.6"],
        ["jest-serializer", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-worker", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-worker-27.0.6-a5fdb1e14ad34eb228cfe162d9f729cdbfa28aed-integrity/node_modules/jest-worker/"),
      packageDependencies: new Map([
        ["@types/node", "16.3.1"],
        ["merge-stream", "2.0.0"],
        ["supports-color", "8.1.1"],
        ["jest-worker", "27.0.6"],
      ]),
    }],
  ])],
  ["merge-stream", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-merge-stream-2.0.0-52823629a14dd00c9770fb6ad47dc6310f2c1f60-integrity/node_modules/merge-stream/"),
      packageDependencies: new Map([
        ["merge-stream", "2.0.0"],
      ]),
    }],
  ])],
  ["walker", new Map([
    ["1.0.7", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-walker-1.0.7-2f7f9b8fd10d677262b18a884e28d19618e028fb-integrity/node_modules/walker/"),
      packageDependencies: new Map([
        ["makeerror", "1.0.11"],
        ["walker", "1.0.7"],
      ]),
    }],
  ])],
  ["makeerror", new Map([
    ["1.0.11", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-makeerror-1.0.11-e01a5c9109f2af79660e4e8b9587790184f5a96c-integrity/node_modules/makeerror/"),
      packageDependencies: new Map([
        ["tmpl", "1.0.4"],
        ["makeerror", "1.0.11"],
      ]),
    }],
  ])],
  ["tmpl", new Map([
    ["1.0.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-tmpl-1.0.4-23640dd7b42d00433911140820e5cf440e521dd1-integrity/node_modules/tmpl/"),
      packageDependencies: new Map([
        ["tmpl", "1.0.4"],
      ]),
    }],
  ])],
  ["fsevents", new Map([
    ["2.3.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-fsevents-2.3.2-8a526f78b8fdf4623b709e0b975c52c24c02fd1a-integrity/node_modules/fsevents/"),
      packageDependencies: new Map([
        ["fsevents", "2.3.2"],
      ]),
    }],
  ])],
  ["pirates", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-pirates-4.0.1-643a92caf894566f91b2b986d2c66950a8e2fb87-integrity/node_modules/pirates/"),
      packageDependencies: new Map([
        ["node-modules-regexp", "1.0.0"],
        ["pirates", "4.0.1"],
      ]),
    }],
  ])],
  ["node-modules-regexp", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-node-modules-regexp-1.0.0-8d9dbe28964a4ac5712e9131642107c71e90ec40-integrity/node_modules/node-modules-regexp/"),
      packageDependencies: new Map([
        ["node-modules-regexp", "1.0.0"],
      ]),
    }],
  ])],
  ["write-file-atomic", new Map([
    ["3.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-write-file-atomic-3.0.3-56bd5c5a5c70481cd19c571bd39ab965a5de56e8-integrity/node_modules/write-file-atomic/"),
      packageDependencies: new Map([
        ["imurmurhash", "0.1.4"],
        ["is-typedarray", "1.0.0"],
        ["signal-exit", "3.0.3"],
        ["typedarray-to-buffer", "3.1.5"],
        ["write-file-atomic", "3.0.3"],
      ]),
    }],
  ])],
  ["imurmurhash", new Map([
    ["0.1.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-imurmurhash-0.1.4-9218b9b2b928a238b13dc4fb6b6d576f231453ea-integrity/node_modules/imurmurhash/"),
      packageDependencies: new Map([
        ["imurmurhash", "0.1.4"],
      ]),
    }],
  ])],
  ["is-typedarray", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-is-typedarray-1.0.0-e479c80858df0c1b11ddda6940f96011fcda4a9a-integrity/node_modules/is-typedarray/"),
      packageDependencies: new Map([
        ["is-typedarray", "1.0.0"],
      ]),
    }],
  ])],
  ["signal-exit", new Map([
    ["3.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-signal-exit-3.0.3-a1410c2edd8f077b08b4e253c8eacfcaf057461c-integrity/node_modules/signal-exit/"),
      packageDependencies: new Map([
        ["signal-exit", "3.0.3"],
      ]),
    }],
  ])],
  ["typedarray-to-buffer", new Map([
    ["3.1.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-typedarray-to-buffer-3.1.5-a97ee7a9ff42691b9f783ff1bc5112fe3fca9080-integrity/node_modules/typedarray-to-buffer/"),
      packageDependencies: new Map([
        ["is-typedarray", "1.0.0"],
        ["typedarray-to-buffer", "3.1.5"],
      ]),
    }],
  ])],
  ["exit", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-exit-0.1.2-0632638f8d877cc82107d30a0fff1a17cba1cd0c-integrity/node_modules/exit/"),
      packageDependencies: new Map([
        ["exit", "0.1.2"],
      ]),
    }],
  ])],
  ["istanbul-lib-report", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-istanbul-lib-report-3.0.0-7518fe52ea44de372f460a76b5ecda9ffb73d8a6-integrity/node_modules/istanbul-lib-report/"),
      packageDependencies: new Map([
        ["istanbul-lib-coverage", "3.0.0"],
        ["make-dir", "3.1.0"],
        ["supports-color", "7.2.0"],
        ["istanbul-lib-report", "3.0.0"],
      ]),
    }],
  ])],
  ["make-dir", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-make-dir-3.1.0-415e967046b3a7f1d185277d84aa58203726a13f-integrity/node_modules/make-dir/"),
      packageDependencies: new Map([
        ["semver", "6.3.0"],
        ["make-dir", "3.1.0"],
      ]),
    }],
  ])],
  ["istanbul-lib-source-maps", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-istanbul-lib-source-maps-4.0.0-75743ce6d96bb86dc7ee4352cf6366a23f0b1ad9-integrity/node_modules/istanbul-lib-source-maps/"),
      packageDependencies: new Map([
        ["debug", "4.3.2"],
        ["istanbul-lib-coverage", "3.0.0"],
        ["source-map", "0.6.1"],
        ["istanbul-lib-source-maps", "4.0.0"],
      ]),
    }],
  ])],
  ["istanbul-reports", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-istanbul-reports-3.0.2-d593210e5000683750cb09fc0644e4b6e27fd53b-integrity/node_modules/istanbul-reports/"),
      packageDependencies: new Map([
        ["html-escaper", "2.0.2"],
        ["istanbul-lib-report", "3.0.0"],
        ["istanbul-reports", "3.0.2"],
      ]),
    }],
  ])],
  ["html-escaper", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-html-escaper-2.0.2-dfd60027da36a36dfcbe236262c00a5822681453-integrity/node_modules/html-escaper/"),
      packageDependencies: new Map([
        ["html-escaper", "2.0.2"],
      ]),
    }],
  ])],
  ["jest-resolve", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-resolve-27.0.6-e90f436dd4f8fbf53f58a91c42344864f8e55bff-integrity/node_modules/jest-resolve/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["chalk", "4.1.1"],
        ["escalade", "3.1.1"],
        ["graceful-fs", "4.2.6"],
        ["jest-pnp-resolver", "1.2.2"],
        ["jest-util", "27.0.6"],
        ["jest-validate", "27.0.6"],
        ["resolve", "1.20.0"],
        ["slash", "3.0.0"],
        ["jest-resolve", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-pnp-resolver", new Map([
    ["1.2.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-pnp-resolver-1.2.2-b704ac0ae028a89108a4d040b3f919dfddc8e33c-integrity/node_modules/jest-pnp-resolver/"),
      packageDependencies: new Map([
        ["jest-pnp-resolver", "1.2.2"],
      ]),
    }],
  ])],
  ["jest-validate", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-validate-27.0.6-930a527c7a951927df269f43b2dc23262457e2a6-integrity/node_modules/jest-validate/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["camelcase", "6.2.0"],
        ["chalk", "4.1.1"],
        ["jest-get-type", "27.0.6"],
        ["leven", "3.1.0"],
        ["pretty-format", "27.0.6"],
        ["jest-validate", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-get-type", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-get-type-27.0.6-0eb5c7f755854279ce9b68a9f1a4122f69047cfe-integrity/node_modules/jest-get-type/"),
      packageDependencies: new Map([
        ["jest-get-type", "27.0.6"],
      ]),
    }],
  ])],
  ["leven", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-leven-3.1.0-77891de834064cccba82ae7842bb6b14a13ed7f2-integrity/node_modules/leven/"),
      packageDependencies: new Map([
        ["leven", "3.1.0"],
      ]),
    }],
  ])],
  ["resolve", new Map([
    ["1.20.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-resolve-1.20.0-629a013fb3f70755d6f0b7935cc1c2c5378b1975-integrity/node_modules/resolve/"),
      packageDependencies: new Map([
        ["is-core-module", "2.4.0"],
        ["path-parse", "1.0.7"],
        ["resolve", "1.20.0"],
      ]),
    }],
  ])],
  ["is-core-module", new Map([
    ["2.4.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-is-core-module-2.4.0-8e9fc8e15027b011418026e98f0e6f4d86305cc1-integrity/node_modules/is-core-module/"),
      packageDependencies: new Map([
        ["has", "1.0.3"],
        ["is-core-module", "2.4.0"],
      ]),
    }],
  ])],
  ["path-parse", new Map([
    ["1.0.7", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-path-parse-1.0.7-fbc114b60ca42b30d9daf5858e4bd68bbedb6735-integrity/node_modules/path-parse/"),
      packageDependencies: new Map([
        ["path-parse", "1.0.7"],
      ]),
    }],
  ])],
  ["string-length", new Map([
    ["4.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-string-length-4.0.2-a8a8dc7bd5c1a82b9b3c8b87e125f66871b6e57a-integrity/node_modules/string-length/"),
      packageDependencies: new Map([
        ["char-regex", "1.0.2"],
        ["strip-ansi", "6.0.0"],
        ["string-length", "4.0.2"],
      ]),
    }],
  ])],
  ["char-regex", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-char-regex-1.0.2-d744358226217f981ed58f479b1d6bcc29545dcf-integrity/node_modules/char-regex/"),
      packageDependencies: new Map([
        ["char-regex", "1.0.2"],
      ]),
    }],
  ])],
  ["strip-ansi", new Map([
    ["6.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-strip-ansi-6.0.0-0b1571dd7669ccd4f3e06e14ef1eed26225ae532-integrity/node_modules/strip-ansi/"),
      packageDependencies: new Map([
        ["ansi-regex", "5.0.0"],
        ["strip-ansi", "6.0.0"],
      ]),
    }],
  ])],
  ["terminal-link", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-terminal-link-2.1.1-14a64a27ab3c0df933ea546fba55f2d078edc994-integrity/node_modules/terminal-link/"),
      packageDependencies: new Map([
        ["ansi-escapes", "4.3.2"],
        ["supports-hyperlinks", "2.2.0"],
        ["terminal-link", "2.1.1"],
      ]),
    }],
  ])],
  ["ansi-escapes", new Map([
    ["4.3.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-ansi-escapes-4.3.2-6b2291d1db7d98b6521d5f1efa42d0f3a9feb65e-integrity/node_modules/ansi-escapes/"),
      packageDependencies: new Map([
        ["type-fest", "0.21.3"],
        ["ansi-escapes", "4.3.2"],
      ]),
    }],
  ])],
  ["type-fest", new Map([
    ["0.21.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-type-fest-0.21.3-d260a24b0198436e133fa26a524a6d65fa3b2e37-integrity/node_modules/type-fest/"),
      packageDependencies: new Map([
        ["type-fest", "0.21.3"],
      ]),
    }],
  ])],
  ["supports-hyperlinks", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-supports-hyperlinks-2.2.0-4f77b42488765891774b70c79babd87f9bd594bb-integrity/node_modules/supports-hyperlinks/"),
      packageDependencies: new Map([
        ["has-flag", "4.0.0"],
        ["supports-color", "7.2.0"],
        ["supports-hyperlinks", "2.2.0"],
      ]),
    }],
  ])],
  ["v8-to-istanbul", new Map([
    ["8.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-v8-to-istanbul-8.0.0-4229f2a99e367f3f018fa1d5c2b8ec684667c69c-integrity/node_modules/v8-to-istanbul/"),
      packageDependencies: new Map([
        ["@types/istanbul-lib-coverage", "2.0.3"],
        ["convert-source-map", "1.8.0"],
        ["source-map", "0.7.3"],
        ["v8-to-istanbul", "8.0.0"],
      ]),
    }],
  ])],
  ["emittery", new Map([
    ["0.8.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-emittery-0.8.1-bb23cc86d03b30aa75a7f734819dee2e1ba70860-integrity/node_modules/emittery/"),
      packageDependencies: new Map([
        ["emittery", "0.8.1"],
      ]),
    }],
  ])],
  ["jest-changed-files", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-changed-files-27.0.6-bed6183fcdea8a285482e3b50a9a7712d49a7a8b-integrity/node_modules/jest-changed-files/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["execa", "5.1.1"],
        ["throat", "6.0.1"],
        ["jest-changed-files", "27.0.6"],
      ]),
    }],
  ])],
  ["execa", new Map([
    ["5.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-execa-5.1.1-f80ad9cbf4298f7bd1d4c9555c21e93741c411dd-integrity/node_modules/execa/"),
      packageDependencies: new Map([
        ["cross-spawn", "7.0.3"],
        ["get-stream", "6.0.1"],
        ["human-signals", "2.1.0"],
        ["is-stream", "2.0.0"],
        ["merge-stream", "2.0.0"],
        ["npm-run-path", "4.0.1"],
        ["onetime", "5.1.2"],
        ["signal-exit", "3.0.3"],
        ["strip-final-newline", "2.0.0"],
        ["execa", "5.1.1"],
      ]),
    }],
  ])],
  ["cross-spawn", new Map([
    ["7.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-cross-spawn-7.0.3-f73a85b9d5d41d045551c177e2882d4ac85728a6-integrity/node_modules/cross-spawn/"),
      packageDependencies: new Map([
        ["path-key", "3.1.1"],
        ["shebang-command", "2.0.0"],
        ["which", "2.0.2"],
        ["cross-spawn", "7.0.3"],
      ]),
    }],
  ])],
  ["path-key", new Map([
    ["3.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-path-key-3.1.1-581f6ade658cbba65a0d3380de7753295054f375-integrity/node_modules/path-key/"),
      packageDependencies: new Map([
        ["path-key", "3.1.1"],
      ]),
    }],
  ])],
  ["shebang-command", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-shebang-command-2.0.0-ccd0af4f8835fbdc265b82461aaf0c36663f34ea-integrity/node_modules/shebang-command/"),
      packageDependencies: new Map([
        ["shebang-regex", "3.0.0"],
        ["shebang-command", "2.0.0"],
      ]),
    }],
  ])],
  ["shebang-regex", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-shebang-regex-3.0.0-ae16f1644d873ecad843b0307b143362d4c42172-integrity/node_modules/shebang-regex/"),
      packageDependencies: new Map([
        ["shebang-regex", "3.0.0"],
      ]),
    }],
  ])],
  ["which", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-which-2.0.2-7c6a8dd0a636a0327e10b59c9286eee93f3f51b1-integrity/node_modules/which/"),
      packageDependencies: new Map([
        ["isexe", "2.0.0"],
        ["which", "2.0.2"],
      ]),
    }],
  ])],
  ["isexe", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-isexe-2.0.0-e8fbf374dc556ff8947a10dcb0572d633f2cfa10-integrity/node_modules/isexe/"),
      packageDependencies: new Map([
        ["isexe", "2.0.0"],
      ]),
    }],
  ])],
  ["get-stream", new Map([
    ["6.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-get-stream-6.0.1-a262d8eef67aced57c2852ad6167526a43cbf7b7-integrity/node_modules/get-stream/"),
      packageDependencies: new Map([
        ["get-stream", "6.0.1"],
      ]),
    }],
  ])],
  ["human-signals", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-human-signals-2.1.0-dc91fcba42e4d06e4abaed33b3e7a3c02f514ea0-integrity/node_modules/human-signals/"),
      packageDependencies: new Map([
        ["human-signals", "2.1.0"],
      ]),
    }],
  ])],
  ["is-stream", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-is-stream-2.0.0-bde9c32680d6fae04129d6ac9d921ce7815f78e3-integrity/node_modules/is-stream/"),
      packageDependencies: new Map([
        ["is-stream", "2.0.0"],
      ]),
    }],
  ])],
  ["npm-run-path", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-npm-run-path-4.0.1-b7ecd1e5ed53da8e37a55e1c2269e0b97ed748ea-integrity/node_modules/npm-run-path/"),
      packageDependencies: new Map([
        ["path-key", "3.1.1"],
        ["npm-run-path", "4.0.1"],
      ]),
    }],
  ])],
  ["onetime", new Map([
    ["5.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-onetime-5.1.2-d0e96ebb56b07476df1dd9c4806e5237985ca45e-integrity/node_modules/onetime/"),
      packageDependencies: new Map([
        ["mimic-fn", "2.1.0"],
        ["onetime", "5.1.2"],
      ]),
    }],
  ])],
  ["mimic-fn", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-mimic-fn-2.1.0-7ed2c2ccccaf84d3ffcb7a69b57711fc2083401b-integrity/node_modules/mimic-fn/"),
      packageDependencies: new Map([
        ["mimic-fn", "2.1.0"],
      ]),
    }],
  ])],
  ["strip-final-newline", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-strip-final-newline-2.0.0-89b852fb2fcbe936f6f4b3187afb0a12c1ab58ad-integrity/node_modules/strip-final-newline/"),
      packageDependencies: new Map([
        ["strip-final-newline", "2.0.0"],
      ]),
    }],
  ])],
  ["throat", new Map([
    ["6.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-throat-6.0.1-d514fedad95740c12c2d7fc70ea863eb51ade375-integrity/node_modules/throat/"),
      packageDependencies: new Map([
        ["throat", "6.0.1"],
      ]),
    }],
  ])],
  ["jest-config", new Map([
    ["pnp:03d96a41183e83878005f79a497dffac64cad5f8", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-03d96a41183e83878005f79a497dffac64cad5f8/node_modules/jest-config/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@jest/test-sequencer", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["babel-jest", "27.0.6"],
        ["chalk", "4.1.1"],
        ["deepmerge", "4.2.2"],
        ["glob", "7.1.7"],
        ["graceful-fs", "4.2.6"],
        ["is-ci", "3.0.0"],
        ["jest-circus", "27.0.6"],
        ["jest-environment-jsdom", "27.0.6"],
        ["jest-environment-node", "27.0.6"],
        ["jest-get-type", "27.0.6"],
        ["jest-jasmine2", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-runner", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-validate", "27.0.6"],
        ["micromatch", "4.0.4"],
        ["pretty-format", "27.0.6"],
        ["jest-config", "pnp:03d96a41183e83878005f79a497dffac64cad5f8"],
      ]),
    }],
    ["pnp:0f0e2a91a6379bbdf821c39c6146ea3908288fe2", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-0f0e2a91a6379bbdf821c39c6146ea3908288fe2/node_modules/jest-config/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@jest/test-sequencer", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["babel-jest", "27.0.6"],
        ["chalk", "4.1.1"],
        ["deepmerge", "4.2.2"],
        ["glob", "7.1.7"],
        ["graceful-fs", "4.2.6"],
        ["is-ci", "3.0.0"],
        ["jest-circus", "27.0.6"],
        ["jest-environment-jsdom", "27.0.6"],
        ["jest-environment-node", "27.0.6"],
        ["jest-get-type", "27.0.6"],
        ["jest-jasmine2", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-runner", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-validate", "27.0.6"],
        ["micromatch", "4.0.4"],
        ["pretty-format", "27.0.6"],
        ["jest-config", "pnp:0f0e2a91a6379bbdf821c39c6146ea3908288fe2"],
      ]),
    }],
    ["pnp:1d860a5e1d1afe3406204bf0a88934989701a085", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-1d860a5e1d1afe3406204bf0a88934989701a085/node_modules/jest-config/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@jest/test-sequencer", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["babel-jest", "27.0.6"],
        ["chalk", "4.1.1"],
        ["deepmerge", "4.2.2"],
        ["glob", "7.1.7"],
        ["graceful-fs", "4.2.6"],
        ["is-ci", "3.0.0"],
        ["jest-circus", "27.0.6"],
        ["jest-environment-jsdom", "27.0.6"],
        ["jest-environment-node", "27.0.6"],
        ["jest-get-type", "27.0.6"],
        ["jest-jasmine2", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-runner", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-validate", "27.0.6"],
        ["micromatch", "4.0.4"],
        ["pretty-format", "27.0.6"],
        ["jest-config", "pnp:1d860a5e1d1afe3406204bf0a88934989701a085"],
      ]),
    }],
  ])],
  ["@jest/test-sequencer", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-test-sequencer-27.0.6-80a913ed7a1130545b1cd777ff2735dd3af5d34b-integrity/node_modules/@jest/test-sequencer/"),
      packageDependencies: new Map([
        ["@jest/test-result", "27.0.6"],
        ["graceful-fs", "4.2.6"],
        ["jest-haste-map", "27.0.6"],
        ["jest-runtime", "27.0.6"],
        ["@jest/test-sequencer", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-runtime", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-runtime-27.0.6-45877cfcd386afdd4f317def551fc369794c27c9-integrity/node_modules/jest-runtime/"),
      packageDependencies: new Map([
        ["@jest/console", "27.0.6"],
        ["@jest/environment", "27.0.6"],
        ["@jest/fake-timers", "27.0.6"],
        ["@jest/globals", "27.0.6"],
        ["@jest/source-map", "27.0.6"],
        ["@jest/test-result", "27.0.6"],
        ["@jest/transform", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/yargs", "16.0.4"],
        ["chalk", "4.1.1"],
        ["cjs-module-lexer", "1.2.1"],
        ["collect-v8-coverage", "1.0.1"],
        ["exit", "0.1.2"],
        ["glob", "7.1.7"],
        ["graceful-fs", "4.2.6"],
        ["jest-haste-map", "27.0.6"],
        ["jest-message-util", "27.0.6"],
        ["jest-mock", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-snapshot", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-validate", "27.0.6"],
        ["slash", "3.0.0"],
        ["strip-bom", "4.0.0"],
        ["yargs", "16.2.0"],
        ["jest-runtime", "27.0.6"],
      ]),
    }],
  ])],
  ["@jest/environment", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-environment-27.0.6-ee293fe996db01d7d663b8108fa0e1ff436219d2-integrity/node_modules/@jest/environment/"),
      packageDependencies: new Map([
        ["@jest/fake-timers", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["jest-mock", "27.0.6"],
        ["@jest/environment", "27.0.6"],
      ]),
    }],
  ])],
  ["@jest/fake-timers", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-fake-timers-27.0.6-cbad52f3fe6abe30e7acb8cd5fa3466b9588e3df-integrity/node_modules/@jest/fake-timers/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["@sinonjs/fake-timers", "7.1.2"],
        ["@types/node", "16.3.1"],
        ["jest-message-util", "27.0.6"],
        ["jest-mock", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["@jest/fake-timers", "27.0.6"],
      ]),
    }],
  ])],
  ["@sinonjs/fake-timers", new Map([
    ["7.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@sinonjs-fake-timers-7.1.2-2524eae70c4910edccf99b2f4e6efc5894aff7b5-integrity/node_modules/@sinonjs/fake-timers/"),
      packageDependencies: new Map([
        ["@sinonjs/commons", "1.8.3"],
        ["@sinonjs/fake-timers", "7.1.2"],
      ]),
    }],
  ])],
  ["@sinonjs/commons", new Map([
    ["1.8.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@sinonjs-commons-1.8.3-3802ddd21a50a949b6721ddd72da36e67e7f1b2d-integrity/node_modules/@sinonjs/commons/"),
      packageDependencies: new Map([
        ["type-detect", "4.0.8"],
        ["@sinonjs/commons", "1.8.3"],
      ]),
    }],
  ])],
  ["type-detect", new Map([
    ["4.0.8", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-type-detect-4.0.8-7646fb5f18871cfbb7749e69bd39a6388eb7450c-integrity/node_modules/type-detect/"),
      packageDependencies: new Map([
        ["type-detect", "4.0.8"],
      ]),
    }],
  ])],
  ["jest-mock", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-mock-27.0.6-0efdd40851398307ba16778728f6d34d583e3467-integrity/node_modules/jest-mock/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["jest-mock", "27.0.6"],
      ]),
    }],
  ])],
  ["@jest/globals", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-globals-27.0.6-48e3903f99a4650673d8657334d13c9caf0e8f82-integrity/node_modules/@jest/globals/"),
      packageDependencies: new Map([
        ["@jest/environment", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["expect", "27.0.6"],
        ["@jest/globals", "27.0.6"],
      ]),
    }],
  ])],
  ["expect", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-expect-27.0.6-a4d74fbe27222c718fff68ef49d78e26a8fd4c05-integrity/node_modules/expect/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["ansi-styles", "5.2.0"],
        ["jest-get-type", "27.0.6"],
        ["jest-matcher-utils", "27.0.6"],
        ["jest-message-util", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["expect", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-matcher-utils", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-matcher-utils-27.0.6-2a8da1e86c620b39459f4352eaa255f0d43e39a9-integrity/node_modules/jest-matcher-utils/"),
      packageDependencies: new Map([
        ["chalk", "4.1.1"],
        ["jest-diff", "27.0.6"],
        ["jest-get-type", "27.0.6"],
        ["pretty-format", "27.0.6"],
        ["jest-matcher-utils", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-diff", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-diff-27.0.6-4a7a19ee6f04ad70e0e3388f35829394a44c7b5e-integrity/node_modules/jest-diff/"),
      packageDependencies: new Map([
        ["chalk", "4.1.1"],
        ["diff-sequences", "27.0.6"],
        ["jest-get-type", "27.0.6"],
        ["pretty-format", "27.0.6"],
        ["jest-diff", "27.0.6"],
      ]),
    }],
  ])],
  ["diff-sequences", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-diff-sequences-27.0.6-3305cb2e55a033924054695cc66019fd7f8e5723-integrity/node_modules/diff-sequences/"),
      packageDependencies: new Map([
        ["diff-sequences", "27.0.6"],
      ]),
    }],
  ])],
  ["@jest/source-map", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@jest-source-map-27.0.6-be9e9b93565d49b0548b86e232092491fb60551f-integrity/node_modules/@jest/source-map/"),
      packageDependencies: new Map([
        ["callsites", "3.1.0"],
        ["graceful-fs", "4.2.6"],
        ["source-map", "0.6.1"],
        ["@jest/source-map", "27.0.6"],
      ]),
    }],
  ])],
  ["callsites", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-callsites-3.1.0-b3630abd8943432f54b3f0519238e33cd7df2f73-integrity/node_modules/callsites/"),
      packageDependencies: new Map([
        ["callsites", "3.1.0"],
      ]),
    }],
  ])],
  ["cjs-module-lexer", new Map([
    ["1.2.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-cjs-module-lexer-1.2.1-2fd46d9906a126965aa541345c499aaa18e8cd73-integrity/node_modules/cjs-module-lexer/"),
      packageDependencies: new Map([
        ["cjs-module-lexer", "1.2.1"],
      ]),
    }],
  ])],
  ["jest-snapshot", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-snapshot-27.0.6-f4e6b208bd2e92e888344d78f0f650bcff05a4bf-integrity/node_modules/jest-snapshot/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/generator", "7.14.5"],
        ["@babel/parser", "7.14.7"],
        ["@babel/plugin-syntax-typescript", "7.14.5"],
        ["@babel/traverse", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["@jest/transform", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/babel__traverse", "7.14.2"],
        ["@types/prettier", "2.3.2"],
        ["babel-preset-current-node-syntax", "pnp:41830d6beb45de28115d10519b496c20a033d9cb"],
        ["chalk", "4.1.1"],
        ["expect", "27.0.6"],
        ["graceful-fs", "4.2.6"],
        ["jest-diff", "27.0.6"],
        ["jest-get-type", "27.0.6"],
        ["jest-haste-map", "27.0.6"],
        ["jest-matcher-utils", "27.0.6"],
        ["jest-message-util", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["natural-compare", "1.4.0"],
        ["pretty-format", "27.0.6"],
        ["semver", "7.3.5"],
        ["jest-snapshot", "27.0.6"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-typescript", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-typescript-7.14.5-b82c6ce471b165b5ce420cf92914d6fb46225716-integrity/node_modules/@babel/plugin-syntax-typescript/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-typescript", "7.14.5"],
      ]),
    }],
  ])],
  ["@types/babel__traverse", new Map([
    ["7.14.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-babel-traverse-7.14.2-ffcd470bbb3f8bf30481678fb5502278ca833a43-integrity/node_modules/@types/babel__traverse/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@types/babel__traverse", "7.14.2"],
      ]),
    }],
  ])],
  ["@types/prettier", new Map([
    ["2.3.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-prettier-2.3.2-fc8c2825e4ed2142473b4a81064e6e081463d1b3-integrity/node_modules/@types/prettier/"),
      packageDependencies: new Map([
        ["@types/prettier", "2.3.2"],
      ]),
    }],
  ])],
  ["babel-preset-current-node-syntax", new Map([
    ["pnp:41830d6beb45de28115d10519b496c20a033d9cb", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-41830d6beb45de28115d10519b496c20a033d9cb/node_modules/babel-preset-current-node-syntax/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/plugin-syntax-async-generators", "7.8.4"],
        ["@babel/plugin-syntax-bigint", "7.8.3"],
        ["@babel/plugin-syntax-class-properties", "7.12.13"],
        ["@babel/plugin-syntax-import-meta", "7.10.4"],
        ["@babel/plugin-syntax-json-strings", "7.8.3"],
        ["@babel/plugin-syntax-logical-assignment-operators", "7.10.4"],
        ["@babel/plugin-syntax-nullish-coalescing-operator", "7.8.3"],
        ["@babel/plugin-syntax-numeric-separator", "7.10.4"],
        ["@babel/plugin-syntax-object-rest-spread", "7.8.3"],
        ["@babel/plugin-syntax-optional-catch-binding", "7.8.3"],
        ["@babel/plugin-syntax-optional-chaining", "7.8.3"],
        ["@babel/plugin-syntax-top-level-await", "7.14.5"],
        ["babel-preset-current-node-syntax", "pnp:41830d6beb45de28115d10519b496c20a033d9cb"],
      ]),
    }],
    ["pnp:c15c49eefe8107cbd918f51276ff72b26e22b26d", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-c15c49eefe8107cbd918f51276ff72b26e22b26d/node_modules/babel-preset-current-node-syntax/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/plugin-syntax-async-generators", "7.8.4"],
        ["@babel/plugin-syntax-bigint", "7.8.3"],
        ["@babel/plugin-syntax-class-properties", "7.12.13"],
        ["@babel/plugin-syntax-import-meta", "7.10.4"],
        ["@babel/plugin-syntax-json-strings", "7.8.3"],
        ["@babel/plugin-syntax-logical-assignment-operators", "7.10.4"],
        ["@babel/plugin-syntax-nullish-coalescing-operator", "7.8.3"],
        ["@babel/plugin-syntax-numeric-separator", "7.10.4"],
        ["@babel/plugin-syntax-object-rest-spread", "7.8.3"],
        ["@babel/plugin-syntax-optional-catch-binding", "7.8.3"],
        ["@babel/plugin-syntax-optional-chaining", "7.8.3"],
        ["@babel/plugin-syntax-top-level-await", "7.14.5"],
        ["babel-preset-current-node-syntax", "pnp:c15c49eefe8107cbd918f51276ff72b26e22b26d"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-async-generators", new Map([
    ["7.8.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-async-generators-7.8.4-a983fb1aeb2ec3f6ed042a210f640e90e786fe0d-integrity/node_modules/@babel/plugin-syntax-async-generators/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-async-generators", "7.8.4"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-bigint", new Map([
    ["7.8.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-bigint-7.8.3-4c9a6f669f5d0cdf1b90a1671e9a146be5300cea-integrity/node_modules/@babel/plugin-syntax-bigint/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-bigint", "7.8.3"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-class-properties", new Map([
    ["7.12.13", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-class-properties-7.12.13-b5c987274c4a3a82b89714796931a6b53544ae10-integrity/node_modules/@babel/plugin-syntax-class-properties/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-class-properties", "7.12.13"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-import-meta", new Map([
    ["7.10.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-import-meta-7.10.4-ee601348c370fa334d2207be158777496521fd51-integrity/node_modules/@babel/plugin-syntax-import-meta/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-import-meta", "7.10.4"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-json-strings", new Map([
    ["7.8.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-json-strings-7.8.3-01ca21b668cd8218c9e640cb6dd88c5412b2c96a-integrity/node_modules/@babel/plugin-syntax-json-strings/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-json-strings", "7.8.3"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-logical-assignment-operators", new Map([
    ["7.10.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-logical-assignment-operators-7.10.4-ca91ef46303530448b906652bac2e9fe9941f699-integrity/node_modules/@babel/plugin-syntax-logical-assignment-operators/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-logical-assignment-operators", "7.10.4"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-nullish-coalescing-operator", new Map([
    ["7.8.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-nullish-coalescing-operator-7.8.3-167ed70368886081f74b5c36c65a88c03b66d1a9-integrity/node_modules/@babel/plugin-syntax-nullish-coalescing-operator/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-nullish-coalescing-operator", "7.8.3"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-numeric-separator", new Map([
    ["7.10.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-numeric-separator-7.10.4-b9b070b3e33570cd9fd07ba7fa91c0dd37b9af97-integrity/node_modules/@babel/plugin-syntax-numeric-separator/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-numeric-separator", "7.10.4"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-object-rest-spread", new Map([
    ["7.8.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-object-rest-spread-7.8.3-60e225edcbd98a640332a2e72dd3e66f1af55871-integrity/node_modules/@babel/plugin-syntax-object-rest-spread/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-object-rest-spread", "7.8.3"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-optional-catch-binding", new Map([
    ["7.8.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-optional-catch-binding-7.8.3-6111a265bcfb020eb9efd0fdfd7d26402b9ed6c1-integrity/node_modules/@babel/plugin-syntax-optional-catch-binding/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-optional-catch-binding", "7.8.3"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-optional-chaining", new Map([
    ["7.8.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-optional-chaining-7.8.3-4f69c2ab95167e0180cd5336613f8c5788f7d48a-integrity/node_modules/@babel/plugin-syntax-optional-chaining/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-optional-chaining", "7.8.3"],
      ]),
    }],
  ])],
  ["@babel/plugin-syntax-top-level-await", new Map([
    ["7.14.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-top-level-await-7.14.5-c1cfdadc35a646240001f06138247b741c34d94c-integrity/node_modules/@babel/plugin-syntax-top-level-await/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@babel/helper-plugin-utils", "7.14.5"],
        ["@babel/plugin-syntax-top-level-await", "7.14.5"],
      ]),
    }],
  ])],
  ["natural-compare", new Map([
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-natural-compare-1.4.0-4abebfeed7541f2c27acfb29bdbbd15c8d5ba4f7-integrity/node_modules/natural-compare/"),
      packageDependencies: new Map([
        ["natural-compare", "1.4.0"],
      ]),
    }],
  ])],
  ["lru-cache", new Map([
    ["6.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-lru-cache-6.0.0-6d6fe6570ebd96aaf90fcad1dafa3b2566db3a94-integrity/node_modules/lru-cache/"),
      packageDependencies: new Map([
        ["yallist", "4.0.0"],
        ["lru-cache", "6.0.0"],
      ]),
    }],
  ])],
  ["yallist", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-yallist-4.0.0-9bb92790d9c0effec63be73519e11a35019a3a72-integrity/node_modules/yallist/"),
      packageDependencies: new Map([
        ["yallist", "4.0.0"],
      ]),
    }],
  ])],
  ["strip-bom", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-strip-bom-4.0.0-9c3505c1db45bcedca3d9cf7a16f5c5aa3901878-integrity/node_modules/strip-bom/"),
      packageDependencies: new Map([
        ["strip-bom", "4.0.0"],
      ]),
    }],
  ])],
  ["yargs", new Map([
    ["16.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-yargs-16.2.0-1c82bf0f6b6a66eafce7ef30e376f49a12477f66-integrity/node_modules/yargs/"),
      packageDependencies: new Map([
        ["cliui", "7.0.4"],
        ["escalade", "3.1.1"],
        ["get-caller-file", "2.0.5"],
        ["require-directory", "2.1.1"],
        ["string-width", "4.2.2"],
        ["y18n", "5.0.8"],
        ["yargs-parser", "20.2.9"],
        ["yargs", "16.2.0"],
      ]),
    }],
  ])],
  ["cliui", new Map([
    ["7.0.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-cliui-7.0.4-a0265ee655476fc807aea9df3df8df7783808b4f-integrity/node_modules/cliui/"),
      packageDependencies: new Map([
        ["string-width", "4.2.2"],
        ["strip-ansi", "6.0.0"],
        ["wrap-ansi", "7.0.0"],
        ["cliui", "7.0.4"],
      ]),
    }],
  ])],
  ["string-width", new Map([
    ["4.2.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-string-width-4.2.2-dafd4f9559a7585cfba529c6a0a4f73488ebd4c5-integrity/node_modules/string-width/"),
      packageDependencies: new Map([
        ["emoji-regex", "8.0.0"],
        ["is-fullwidth-code-point", "3.0.0"],
        ["strip-ansi", "6.0.0"],
        ["string-width", "4.2.2"],
      ]),
    }],
  ])],
  ["emoji-regex", new Map([
    ["8.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-emoji-regex-8.0.0-e818fd69ce5ccfcb404594f842963bf53164cc37-integrity/node_modules/emoji-regex/"),
      packageDependencies: new Map([
        ["emoji-regex", "8.0.0"],
      ]),
    }],
  ])],
  ["is-fullwidth-code-point", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-is-fullwidth-code-point-3.0.0-f116f8064fe90b3f7844a38997c0b75051269f1d-integrity/node_modules/is-fullwidth-code-point/"),
      packageDependencies: new Map([
        ["is-fullwidth-code-point", "3.0.0"],
      ]),
    }],
  ])],
  ["wrap-ansi", new Map([
    ["7.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-wrap-ansi-7.0.0-67e145cff510a6a6984bdf1152911d69d2eb9e43-integrity/node_modules/wrap-ansi/"),
      packageDependencies: new Map([
        ["ansi-styles", "4.3.0"],
        ["string-width", "4.2.2"],
        ["strip-ansi", "6.0.0"],
        ["wrap-ansi", "7.0.0"],
      ]),
    }],
  ])],
  ["get-caller-file", new Map([
    ["2.0.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-get-caller-file-2.0.5-4f94412a82db32f36e3b0b9741f8a97feb031f7e-integrity/node_modules/get-caller-file/"),
      packageDependencies: new Map([
        ["get-caller-file", "2.0.5"],
      ]),
    }],
  ])],
  ["require-directory", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-require-directory-2.1.1-8c64ad5fd30dab1c976e2344ffe7f792a6a6df42-integrity/node_modules/require-directory/"),
      packageDependencies: new Map([
        ["require-directory", "2.1.1"],
      ]),
    }],
  ])],
  ["y18n", new Map([
    ["5.0.8", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-y18n-5.0.8-7f4934d0f7ca8c56f95314939ddcd2dd91ce1d55-integrity/node_modules/y18n/"),
      packageDependencies: new Map([
        ["y18n", "5.0.8"],
      ]),
    }],
  ])],
  ["yargs-parser", new Map([
    ["20.2.9", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-yargs-parser-20.2.9-2eb7dc3b0289718fc295f362753845c41a0c94ee-integrity/node_modules/yargs-parser/"),
      packageDependencies: new Map([
        ["yargs-parser", "20.2.9"],
      ]),
    }],
  ])],
  ["babel-jest", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-babel-jest-27.0.6-e99c6e0577da2655118e3608b68761a5a69bd0d8-integrity/node_modules/babel-jest/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["@jest/transform", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/babel__core", "7.1.15"],
        ["babel-plugin-istanbul", "6.0.0"],
        ["babel-preset-jest", "27.0.6"],
        ["chalk", "4.1.1"],
        ["graceful-fs", "4.2.6"],
        ["slash", "3.0.0"],
        ["babel-jest", "27.0.6"],
      ]),
    }],
  ])],
  ["@types/babel__core", new Map([
    ["7.1.15", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-babel-core-7.1.15-2ccfb1ad55a02c83f8e0ad327cbc332f55eb1024-integrity/node_modules/@types/babel__core/"),
      packageDependencies: new Map([
        ["@babel/parser", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["@types/babel__generator", "7.6.3"],
        ["@types/babel__template", "7.4.1"],
        ["@types/babel__traverse", "7.14.2"],
        ["@types/babel__core", "7.1.15"],
      ]),
    }],
  ])],
  ["@types/babel__generator", new Map([
    ["7.6.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-babel-generator-7.6.3-f456b4b2ce79137f768aa130d2423d2f0ccfaba5-integrity/node_modules/@types/babel__generator/"),
      packageDependencies: new Map([
        ["@babel/types", "7.14.5"],
        ["@types/babel__generator", "7.6.3"],
      ]),
    }],
  ])],
  ["@types/babel__template", new Map([
    ["7.4.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@types-babel-template-7.4.1-3d1a48fd9d6c0edfd56f2ff578daed48f36c8969-integrity/node_modules/@types/babel__template/"),
      packageDependencies: new Map([
        ["@babel/parser", "7.14.7"],
        ["@babel/types", "7.14.5"],
        ["@types/babel__template", "7.4.1"],
      ]),
    }],
  ])],
  ["babel-preset-jest", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-babel-preset-jest-27.0.6-909ef08e9f24a4679768be2f60a3df0856843f9d-integrity/node_modules/babel-preset-jest/"),
      packageDependencies: new Map([
        ["@babel/core", "7.14.6"],
        ["babel-plugin-jest-hoist", "27.0.6"],
        ["babel-preset-current-node-syntax", "pnp:c15c49eefe8107cbd918f51276ff72b26e22b26d"],
        ["babel-preset-jest", "27.0.6"],
      ]),
    }],
  ])],
  ["babel-plugin-jest-hoist", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-babel-plugin-jest-hoist-27.0.6-f7c6b3d764af21cb4a2a1ab6870117dbde15b456-integrity/node_modules/babel-plugin-jest-hoist/"),
      packageDependencies: new Map([
        ["@babel/template", "7.14.5"],
        ["@babel/types", "7.14.5"],
        ["@types/babel__core", "7.1.15"],
        ["@types/babel__traverse", "7.14.2"],
        ["babel-plugin-jest-hoist", "27.0.6"],
      ]),
    }],
  ])],
  ["deepmerge", new Map([
    ["4.2.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-deepmerge-4.2.2-44d2ea3679b8f4d4ffba33f03d865fc1e7bf4955-integrity/node_modules/deepmerge/"),
      packageDependencies: new Map([
        ["deepmerge", "4.2.2"],
      ]),
    }],
  ])],
  ["jest-circus", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-circus-27.0.6-dd4df17c4697db6a2c232aaad4e9cec666926668-integrity/node_modules/jest-circus/"),
      packageDependencies: new Map([
        ["@jest/environment", "27.0.6"],
        ["@jest/test-result", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["chalk", "4.1.1"],
        ["co", "4.6.0"],
        ["dedent", "0.7.0"],
        ["expect", "27.0.6"],
        ["is-generator-fn", "2.1.0"],
        ["jest-each", "27.0.6"],
        ["jest-matcher-utils", "27.0.6"],
        ["jest-message-util", "27.0.6"],
        ["jest-runtime", "27.0.6"],
        ["jest-snapshot", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["pretty-format", "27.0.6"],
        ["slash", "3.0.0"],
        ["stack-utils", "2.0.3"],
        ["throat", "6.0.1"],
        ["jest-circus", "27.0.6"],
      ]),
    }],
  ])],
  ["co", new Map([
    ["4.6.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-co-4.6.0-6ea6bdf3d853ae54ccb8e47bfa0bf3f9031fb184-integrity/node_modules/co/"),
      packageDependencies: new Map([
        ["co", "4.6.0"],
      ]),
    }],
  ])],
  ["dedent", new Map([
    ["0.7.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-dedent-0.7.0-2495ddbaf6eb874abb0e1be9df22d2e5a544326c-integrity/node_modules/dedent/"),
      packageDependencies: new Map([
        ["dedent", "0.7.0"],
      ]),
    }],
  ])],
  ["is-generator-fn", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-is-generator-fn-2.1.0-7d140adc389aaf3011a8f2a2a4cfa6faadffb118-integrity/node_modules/is-generator-fn/"),
      packageDependencies: new Map([
        ["is-generator-fn", "2.1.0"],
      ]),
    }],
  ])],
  ["jest-each", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-each-27.0.6-cee117071b04060158dc8d9a66dc50ad40ef453b-integrity/node_modules/jest-each/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["chalk", "4.1.1"],
        ["jest-get-type", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["pretty-format", "27.0.6"],
        ["jest-each", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-environment-jsdom", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-environment-jsdom-27.0.6-f66426c4c9950807d0a9f209c590ce544f73291f-integrity/node_modules/jest-environment-jsdom/"),
      packageDependencies: new Map([
        ["@jest/environment", "27.0.6"],
        ["@jest/fake-timers", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["jest-mock", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jsdom", "16.6.0"],
        ["jest-environment-jsdom", "27.0.6"],
      ]),
    }],
  ])],
  ["jsdom", new Map([
    ["16.6.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jsdom-16.6.0-f79b3786682065492a3da6a60a4695da983805ac-integrity/node_modules/jsdom/"),
      packageDependencies: new Map([
        ["abab", "2.0.5"],
        ["acorn", "8.4.1"],
        ["acorn-globals", "6.0.0"],
        ["cssom", "0.4.4"],
        ["cssstyle", "2.3.0"],
        ["data-urls", "2.0.0"],
        ["decimal.js", "10.3.1"],
        ["domexception", "2.0.1"],
        ["escodegen", "2.0.0"],
        ["form-data", "3.0.1"],
        ["html-encoding-sniffer", "2.0.1"],
        ["http-proxy-agent", "4.0.1"],
        ["https-proxy-agent", "5.0.0"],
        ["is-potential-custom-element-name", "1.0.1"],
        ["nwsapi", "2.2.0"],
        ["parse5", "6.0.1"],
        ["saxes", "5.0.1"],
        ["symbol-tree", "3.2.4"],
        ["tough-cookie", "4.0.0"],
        ["w3c-hr-time", "1.0.2"],
        ["w3c-xmlserializer", "2.0.0"],
        ["webidl-conversions", "6.1.0"],
        ["whatwg-encoding", "1.0.5"],
        ["whatwg-mimetype", "2.3.0"],
        ["whatwg-url", "8.7.0"],
        ["ws", "7.5.3"],
        ["xml-name-validator", "3.0.0"],
        ["jsdom", "16.6.0"],
      ]),
    }],
  ])],
  ["abab", new Map([
    ["2.0.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-abab-2.0.5-c0b678fb32d60fc1219c784d6a826fe385aeb79a-integrity/node_modules/abab/"),
      packageDependencies: new Map([
        ["abab", "2.0.5"],
      ]),
    }],
  ])],
  ["acorn", new Map([
    ["8.4.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-acorn-8.4.1-56c36251fc7cabc7096adc18f05afe814321a28c-integrity/node_modules/acorn/"),
      packageDependencies: new Map([
        ["acorn", "8.4.1"],
      ]),
    }],
    ["7.4.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-acorn-7.4.1-feaed255973d2e77555b83dbc08851a6c63520fa-integrity/node_modules/acorn/"),
      packageDependencies: new Map([
        ["acorn", "7.4.1"],
      ]),
    }],
  ])],
  ["acorn-globals", new Map([
    ["6.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-acorn-globals-6.0.0-46cdd39f0f8ff08a876619b55f5ac8a6dc770b45-integrity/node_modules/acorn-globals/"),
      packageDependencies: new Map([
        ["acorn", "7.4.1"],
        ["acorn-walk", "7.2.0"],
        ["acorn-globals", "6.0.0"],
      ]),
    }],
  ])],
  ["acorn-walk", new Map([
    ["7.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-acorn-walk-7.2.0-0de889a601203909b0fbe07b8938dc21d2e967bc-integrity/node_modules/acorn-walk/"),
      packageDependencies: new Map([
        ["acorn-walk", "7.2.0"],
      ]),
    }],
  ])],
  ["cssom", new Map([
    ["0.4.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-cssom-0.4.4-5a66cf93d2d0b661d80bf6a44fb65f5c2e4e0a10-integrity/node_modules/cssom/"),
      packageDependencies: new Map([
        ["cssom", "0.4.4"],
      ]),
    }],
    ["0.3.8", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-cssom-0.3.8-9f1276f5b2b463f2114d3f2c75250af8c1a36f4a-integrity/node_modules/cssom/"),
      packageDependencies: new Map([
        ["cssom", "0.3.8"],
      ]),
    }],
  ])],
  ["cssstyle", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-cssstyle-2.3.0-ff665a0ddbdc31864b09647f34163443d90b0852-integrity/node_modules/cssstyle/"),
      packageDependencies: new Map([
        ["cssom", "0.3.8"],
        ["cssstyle", "2.3.0"],
      ]),
    }],
  ])],
  ["data-urls", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-data-urls-2.0.0-156485a72963a970f5d5821aaf642bef2bf2db9b-integrity/node_modules/data-urls/"),
      packageDependencies: new Map([
        ["abab", "2.0.5"],
        ["whatwg-mimetype", "2.3.0"],
        ["whatwg-url", "8.7.0"],
        ["data-urls", "2.0.0"],
      ]),
    }],
  ])],
  ["whatwg-mimetype", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-whatwg-mimetype-2.3.0-3d4b1e0312d2079879f826aff18dbeeca5960fbf-integrity/node_modules/whatwg-mimetype/"),
      packageDependencies: new Map([
        ["whatwg-mimetype", "2.3.0"],
      ]),
    }],
  ])],
  ["whatwg-url", new Map([
    ["8.7.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-whatwg-url-8.7.0-656a78e510ff8f3937bc0bcbe9f5c0ac35941b77-integrity/node_modules/whatwg-url/"),
      packageDependencies: new Map([
        ["lodash", "4.17.21"],
        ["tr46", "2.1.0"],
        ["webidl-conversions", "6.1.0"],
        ["whatwg-url", "8.7.0"],
      ]),
    }],
  ])],
  ["lodash", new Map([
    ["4.17.21", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-lodash-4.17.21-679591c564c3bffaae8454cf0b3df370c3d6911c-integrity/node_modules/lodash/"),
      packageDependencies: new Map([
        ["lodash", "4.17.21"],
      ]),
    }],
  ])],
  ["tr46", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-tr46-2.1.0-fa87aa81ca5d5941da8cbf1f9b749dc969a4e240-integrity/node_modules/tr46/"),
      packageDependencies: new Map([
        ["punycode", "2.1.1"],
        ["tr46", "2.1.0"],
      ]),
    }],
  ])],
  ["punycode", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-punycode-2.1.1-b58b010ac40c22c5657616c8d2c2c02c7bf479ec-integrity/node_modules/punycode/"),
      packageDependencies: new Map([
        ["punycode", "2.1.1"],
      ]),
    }],
  ])],
  ["webidl-conversions", new Map([
    ["6.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-webidl-conversions-6.1.0-9111b4d7ea80acd40f5270d666621afa78b69514-integrity/node_modules/webidl-conversions/"),
      packageDependencies: new Map([
        ["webidl-conversions", "6.1.0"],
      ]),
    }],
    ["5.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-webidl-conversions-5.0.0-ae59c8a00b121543a2acc65c0434f57b0fc11aff-integrity/node_modules/webidl-conversions/"),
      packageDependencies: new Map([
        ["webidl-conversions", "5.0.0"],
      ]),
    }],
  ])],
  ["decimal.js", new Map([
    ["10.3.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-decimal-js-10.3.1-d8c3a444a9c6774ba60ca6ad7261c3a94fd5e783-integrity/node_modules/decimal.js/"),
      packageDependencies: new Map([
        ["decimal.js", "10.3.1"],
      ]),
    }],
  ])],
  ["domexception", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-domexception-2.0.1-fb44aefba793e1574b0af6aed2801d057529f304-integrity/node_modules/domexception/"),
      packageDependencies: new Map([
        ["webidl-conversions", "5.0.0"],
        ["domexception", "2.0.1"],
      ]),
    }],
  ])],
  ["escodegen", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-escodegen-2.0.0-5e32b12833e8aa8fa35e1bf0befa89380484c7dd-integrity/node_modules/escodegen/"),
      packageDependencies: new Map([
        ["esprima", "4.0.1"],
        ["estraverse", "5.2.0"],
        ["esutils", "2.0.3"],
        ["optionator", "0.8.3"],
        ["source-map", "0.6.1"],
        ["escodegen", "2.0.0"],
      ]),
    }],
  ])],
  ["estraverse", new Map([
    ["5.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-estraverse-5.2.0-307df42547e6cc7324d3cf03c155d5cdb8c53880-integrity/node_modules/estraverse/"),
      packageDependencies: new Map([
        ["estraverse", "5.2.0"],
      ]),
    }],
  ])],
  ["esutils", new Map([
    ["2.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-esutils-2.0.3-74d2eb4de0b8da1293711910d50775b9b710ef64-integrity/node_modules/esutils/"),
      packageDependencies: new Map([
        ["esutils", "2.0.3"],
      ]),
    }],
  ])],
  ["optionator", new Map([
    ["0.8.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-optionator-0.8.3-84fa1d036fe9d3c7e21d99884b601167ec8fb495-integrity/node_modules/optionator/"),
      packageDependencies: new Map([
        ["deep-is", "0.1.3"],
        ["fast-levenshtein", "2.0.6"],
        ["levn", "0.3.0"],
        ["prelude-ls", "1.1.2"],
        ["type-check", "0.3.2"],
        ["word-wrap", "1.2.3"],
        ["optionator", "0.8.3"],
      ]),
    }],
  ])],
  ["deep-is", new Map([
    ["0.1.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-deep-is-0.1.3-b369d6fb5dbc13eecf524f91b070feedc357cf34-integrity/node_modules/deep-is/"),
      packageDependencies: new Map([
        ["deep-is", "0.1.3"],
      ]),
    }],
  ])],
  ["fast-levenshtein", new Map([
    ["2.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-fast-levenshtein-2.0.6-3d8a5c66883a16a30ca8643e851f19baa7797917-integrity/node_modules/fast-levenshtein/"),
      packageDependencies: new Map([
        ["fast-levenshtein", "2.0.6"],
      ]),
    }],
  ])],
  ["levn", new Map([
    ["0.3.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-levn-0.3.0-3b09924edf9f083c0490fdd4c0bc4421e04764ee-integrity/node_modules/levn/"),
      packageDependencies: new Map([
        ["prelude-ls", "1.1.2"],
        ["type-check", "0.3.2"],
        ["levn", "0.3.0"],
      ]),
    }],
  ])],
  ["prelude-ls", new Map([
    ["1.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-prelude-ls-1.1.2-21932a549f5e52ffd9a827f570e04be62a97da54-integrity/node_modules/prelude-ls/"),
      packageDependencies: new Map([
        ["prelude-ls", "1.1.2"],
      ]),
    }],
  ])],
  ["type-check", new Map([
    ["0.3.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-type-check-0.3.2-5884cab512cf1d355e3fb784f30804b2b520db72-integrity/node_modules/type-check/"),
      packageDependencies: new Map([
        ["prelude-ls", "1.1.2"],
        ["type-check", "0.3.2"],
      ]),
    }],
  ])],
  ["word-wrap", new Map([
    ["1.2.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-word-wrap-1.2.3-610636f6b1f703891bd34771ccb17fb93b47079c-integrity/node_modules/word-wrap/"),
      packageDependencies: new Map([
        ["word-wrap", "1.2.3"],
      ]),
    }],
  ])],
  ["form-data", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-form-data-3.0.1-ebd53791b78356a99af9a300d4282c4d5eb9755f-integrity/node_modules/form-data/"),
      packageDependencies: new Map([
        ["asynckit", "0.4.0"],
        ["combined-stream", "1.0.8"],
        ["mime-types", "2.1.31"],
        ["form-data", "3.0.1"],
      ]),
    }],
  ])],
  ["asynckit", new Map([
    ["0.4.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-asynckit-0.4.0-c79ed97f7f34cb8f2ba1bc9790bcc366474b4b79-integrity/node_modules/asynckit/"),
      packageDependencies: new Map([
        ["asynckit", "0.4.0"],
      ]),
    }],
  ])],
  ["combined-stream", new Map([
    ["1.0.8", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-combined-stream-1.0.8-c3d45a8b34fd730631a110a8a2520682b31d5a7f-integrity/node_modules/combined-stream/"),
      packageDependencies: new Map([
        ["delayed-stream", "1.0.0"],
        ["combined-stream", "1.0.8"],
      ]),
    }],
  ])],
  ["delayed-stream", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-delayed-stream-1.0.0-df3ae199acadfb7d440aaae0b29e2272b24ec619-integrity/node_modules/delayed-stream/"),
      packageDependencies: new Map([
        ["delayed-stream", "1.0.0"],
      ]),
    }],
  ])],
  ["mime-types", new Map([
    ["2.1.31", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-mime-types-2.1.31-a00d76b74317c61f9c2db2218b8e9f8e9c5c9e6b-integrity/node_modules/mime-types/"),
      packageDependencies: new Map([
        ["mime-db", "1.48.0"],
        ["mime-types", "2.1.31"],
      ]),
    }],
  ])],
  ["mime-db", new Map([
    ["1.48.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-mime-db-1.48.0-e35b31045dd7eada3aaad537ed88a33afbef2d1d-integrity/node_modules/mime-db/"),
      packageDependencies: new Map([
        ["mime-db", "1.48.0"],
      ]),
    }],
  ])],
  ["html-encoding-sniffer", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-html-encoding-sniffer-2.0.1-42a6dc4fd33f00281176e8b23759ca4e4fa185f3-integrity/node_modules/html-encoding-sniffer/"),
      packageDependencies: new Map([
        ["whatwg-encoding", "1.0.5"],
        ["html-encoding-sniffer", "2.0.1"],
      ]),
    }],
  ])],
  ["whatwg-encoding", new Map([
    ["1.0.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-whatwg-encoding-1.0.5-5abacf777c32166a51d085d6b4f3e7d27113ddb0-integrity/node_modules/whatwg-encoding/"),
      packageDependencies: new Map([
        ["iconv-lite", "0.4.24"],
        ["whatwg-encoding", "1.0.5"],
      ]),
    }],
  ])],
  ["iconv-lite", new Map([
    ["0.4.24", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-iconv-lite-0.4.24-2022b4b25fbddc21d2f524974a474aafe733908b-integrity/node_modules/iconv-lite/"),
      packageDependencies: new Map([
        ["safer-buffer", "2.1.2"],
        ["iconv-lite", "0.4.24"],
      ]),
    }],
  ])],
  ["safer-buffer", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-safer-buffer-2.1.2-44fa161b0187b9549dd84bb91802f9bd8385cd6a-integrity/node_modules/safer-buffer/"),
      packageDependencies: new Map([
        ["safer-buffer", "2.1.2"],
      ]),
    }],
  ])],
  ["http-proxy-agent", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-http-proxy-agent-4.0.1-8a8c8ef7f5932ccf953c296ca8291b95aa74aa3a-integrity/node_modules/http-proxy-agent/"),
      packageDependencies: new Map([
        ["@tootallnate/once", "1.1.2"],
        ["agent-base", "6.0.2"],
        ["debug", "4.3.2"],
        ["http-proxy-agent", "4.0.1"],
      ]),
    }],
  ])],
  ["@tootallnate/once", new Map([
    ["1.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-@tootallnate-once-1.1.2-ccb91445360179a04e7fe6aff78c00ffc1eeaf82-integrity/node_modules/@tootallnate/once/"),
      packageDependencies: new Map([
        ["@tootallnate/once", "1.1.2"],
      ]),
    }],
  ])],
  ["agent-base", new Map([
    ["6.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-agent-base-6.0.2-49fff58577cfee3f37176feab4c22e00f86d7f77-integrity/node_modules/agent-base/"),
      packageDependencies: new Map([
        ["debug", "4.3.2"],
        ["agent-base", "6.0.2"],
      ]),
    }],
  ])],
  ["https-proxy-agent", new Map([
    ["5.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-https-proxy-agent-5.0.0-e2a90542abb68a762e0a0850f6c9edadfd8506b2-integrity/node_modules/https-proxy-agent/"),
      packageDependencies: new Map([
        ["agent-base", "6.0.2"],
        ["debug", "4.3.2"],
        ["https-proxy-agent", "5.0.0"],
      ]),
    }],
  ])],
  ["is-potential-custom-element-name", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-is-potential-custom-element-name-1.0.1-171ed6f19e3ac554394edf78caa05784a45bebb5-integrity/node_modules/is-potential-custom-element-name/"),
      packageDependencies: new Map([
        ["is-potential-custom-element-name", "1.0.1"],
      ]),
    }],
  ])],
  ["nwsapi", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-nwsapi-2.2.0-204879a9e3d068ff2a55139c2c772780681a38b7-integrity/node_modules/nwsapi/"),
      packageDependencies: new Map([
        ["nwsapi", "2.2.0"],
      ]),
    }],
  ])],
  ["parse5", new Map([
    ["6.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-parse5-6.0.1-e1a1c085c569b3dc08321184f19a39cc27f7c30b-integrity/node_modules/parse5/"),
      packageDependencies: new Map([
        ["parse5", "6.0.1"],
      ]),
    }],
  ])],
  ["saxes", new Map([
    ["5.0.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-saxes-5.0.1-eebab953fa3b7608dbe94e5dadb15c888fa6696d-integrity/node_modules/saxes/"),
      packageDependencies: new Map([
        ["xmlchars", "2.2.0"],
        ["saxes", "5.0.1"],
      ]),
    }],
  ])],
  ["xmlchars", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-xmlchars-2.2.0-060fe1bcb7f9c76fe2a17db86a9bc3ab894210cb-integrity/node_modules/xmlchars/"),
      packageDependencies: new Map([
        ["xmlchars", "2.2.0"],
      ]),
    }],
  ])],
  ["symbol-tree", new Map([
    ["3.2.4", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-symbol-tree-3.2.4-430637d248ba77e078883951fb9aa0eed7c63fa2-integrity/node_modules/symbol-tree/"),
      packageDependencies: new Map([
        ["symbol-tree", "3.2.4"],
      ]),
    }],
  ])],
  ["tough-cookie", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-tough-cookie-4.0.0-d822234eeca882f991f0f908824ad2622ddbece4-integrity/node_modules/tough-cookie/"),
      packageDependencies: new Map([
        ["psl", "1.8.0"],
        ["punycode", "2.1.1"],
        ["universalify", "0.1.2"],
        ["tough-cookie", "4.0.0"],
      ]),
    }],
  ])],
  ["psl", new Map([
    ["1.8.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-psl-1.8.0-9326f8bcfb013adcc005fdff056acce020e51c24-integrity/node_modules/psl/"),
      packageDependencies: new Map([
        ["psl", "1.8.0"],
      ]),
    }],
  ])],
  ["universalify", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-universalify-0.1.2-b646f69be3942dabcecc9d6639c80dc105efaa66-integrity/node_modules/universalify/"),
      packageDependencies: new Map([
        ["universalify", "0.1.2"],
      ]),
    }],
  ])],
  ["w3c-hr-time", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-w3c-hr-time-1.0.2-0a89cdf5cc15822df9c360543676963e0cc308cd-integrity/node_modules/w3c-hr-time/"),
      packageDependencies: new Map([
        ["browser-process-hrtime", "1.0.0"],
        ["w3c-hr-time", "1.0.2"],
      ]),
    }],
  ])],
  ["browser-process-hrtime", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-browser-process-hrtime-1.0.0-3c9b4b7d782c8121e56f10106d84c0d0ffc94626-integrity/node_modules/browser-process-hrtime/"),
      packageDependencies: new Map([
        ["browser-process-hrtime", "1.0.0"],
      ]),
    }],
  ])],
  ["w3c-xmlserializer", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-w3c-xmlserializer-2.0.0-3e7104a05b75146cc60f564380b7f683acf1020a-integrity/node_modules/w3c-xmlserializer/"),
      packageDependencies: new Map([
        ["xml-name-validator", "3.0.0"],
        ["w3c-xmlserializer", "2.0.0"],
      ]),
    }],
  ])],
  ["xml-name-validator", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-xml-name-validator-3.0.0-6ae73e06de4d8c6e47f9fb181f78d648ad457c6a-integrity/node_modules/xml-name-validator/"),
      packageDependencies: new Map([
        ["xml-name-validator", "3.0.0"],
      ]),
    }],
  ])],
  ["ws", new Map([
    ["7.5.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-ws-7.5.3-160835b63c7d97bfab418fc1b8a9fced2ac01a74-integrity/node_modules/ws/"),
      packageDependencies: new Map([
        ["ws", "7.5.3"],
      ]),
    }],
  ])],
  ["jest-environment-node", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-environment-node-27.0.6-a6699b7ceb52e8d68138b9808b0c404e505f3e07-integrity/node_modules/jest-environment-node/"),
      packageDependencies: new Map([
        ["@jest/environment", "27.0.6"],
        ["@jest/fake-timers", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["jest-mock", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-environment-node", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-jasmine2", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-jasmine2-27.0.6-fd509a9ed3d92bd6edb68a779f4738b100655b37-integrity/node_modules/jest-jasmine2/"),
      packageDependencies: new Map([
        ["@babel/traverse", "7.14.7"],
        ["@jest/environment", "27.0.6"],
        ["@jest/source-map", "27.0.6"],
        ["@jest/test-result", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["chalk", "4.1.1"],
        ["co", "4.6.0"],
        ["expect", "27.0.6"],
        ["is-generator-fn", "2.1.0"],
        ["jest-each", "27.0.6"],
        ["jest-matcher-utils", "27.0.6"],
        ["jest-message-util", "27.0.6"],
        ["jest-runtime", "27.0.6"],
        ["jest-snapshot", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["pretty-format", "27.0.6"],
        ["throat", "6.0.1"],
        ["jest-jasmine2", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-runner", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-runner-27.0.6-1325f45055539222bbc7256a6976e993ad2f9520-integrity/node_modules/jest-runner/"),
      packageDependencies: new Map([
        ["@jest/console", "27.0.6"],
        ["@jest/environment", "27.0.6"],
        ["@jest/test-result", "27.0.6"],
        ["@jest/transform", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["chalk", "4.1.1"],
        ["emittery", "0.8.1"],
        ["exit", "0.1.2"],
        ["graceful-fs", "4.2.6"],
        ["jest-docblock", "27.0.6"],
        ["jest-environment-jsdom", "27.0.6"],
        ["jest-environment-node", "27.0.6"],
        ["jest-haste-map", "27.0.6"],
        ["jest-leak-detector", "27.0.6"],
        ["jest-message-util", "27.0.6"],
        ["jest-resolve", "27.0.6"],
        ["jest-runtime", "27.0.6"],
        ["jest-util", "27.0.6"],
        ["jest-worker", "27.0.6"],
        ["source-map-support", "0.5.19"],
        ["throat", "6.0.1"],
        ["jest-runner", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-docblock", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-docblock-27.0.6-cc78266acf7fe693ca462cbbda0ea4e639e4e5f3-integrity/node_modules/jest-docblock/"),
      packageDependencies: new Map([
        ["detect-newline", "3.1.0"],
        ["jest-docblock", "27.0.6"],
      ]),
    }],
  ])],
  ["detect-newline", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-detect-newline-3.1.0-576f5dfc63ae1a192ff192d8ad3af6308991b651-integrity/node_modules/detect-newline/"),
      packageDependencies: new Map([
        ["detect-newline", "3.1.0"],
      ]),
    }],
  ])],
  ["jest-leak-detector", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-leak-detector-27.0.6-545854275f85450d4ef4b8fe305ca2a26450450f-integrity/node_modules/jest-leak-detector/"),
      packageDependencies: new Map([
        ["jest-get-type", "27.0.6"],
        ["pretty-format", "27.0.6"],
        ["jest-leak-detector", "27.0.6"],
      ]),
    }],
  ])],
  ["source-map-support", new Map([
    ["0.5.19", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-source-map-support-0.5.19-a98b62f86dcaf4f67399648c085291ab9e8fed61-integrity/node_modules/source-map-support/"),
      packageDependencies: new Map([
        ["buffer-from", "1.1.1"],
        ["source-map", "0.6.1"],
        ["source-map-support", "0.5.19"],
      ]),
    }],
  ])],
  ["buffer-from", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-buffer-from-1.1.1-32713bc028f75c02fdb710d7c7bcec1f2c6070ef-integrity/node_modules/buffer-from/"),
      packageDependencies: new Map([
        ["buffer-from", "1.1.1"],
      ]),
    }],
  ])],
  ["jest-resolve-dependencies", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-resolve-dependencies-27.0.6-3e619e0ef391c3ecfcf6ef4056207a3d2be3269f-integrity/node_modules/jest-resolve-dependencies/"),
      packageDependencies: new Map([
        ["@jest/types", "27.0.6"],
        ["jest-regex-util", "27.0.6"],
        ["jest-snapshot", "27.0.6"],
        ["jest-resolve-dependencies", "27.0.6"],
      ]),
    }],
  ])],
  ["jest-watcher", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-watcher-27.0.6-89526f7f9edf1eac4e4be989bcb6dec6b8878d9c-integrity/node_modules/jest-watcher/"),
      packageDependencies: new Map([
        ["@jest/test-result", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["@types/node", "16.3.1"],
        ["ansi-escapes", "4.3.2"],
        ["chalk", "4.1.1"],
        ["jest-util", "27.0.6"],
        ["string-length", "4.0.2"],
        ["jest-watcher", "27.0.6"],
      ]),
    }],
  ])],
  ["p-each-series", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-p-each-series-2.2.0-105ab0357ce72b202a8a8b94933672657b5e2a9a-integrity/node_modules/p-each-series/"),
      packageDependencies: new Map([
        ["p-each-series", "2.2.0"],
      ]),
    }],
  ])],
  ["rimraf", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-rimraf-3.0.2-f1a5402ba6220ad52cc1282bac1ae3aa49fd061a-integrity/node_modules/rimraf/"),
      packageDependencies: new Map([
        ["glob", "7.1.7"],
        ["rimraf", "3.0.2"],
      ]),
    }],
  ])],
  ["import-local", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-import-local-3.0.2-a8cfd0431d1de4a2199703d003e3e62364fa6db6-integrity/node_modules/import-local/"),
      packageDependencies: new Map([
        ["pkg-dir", "4.2.0"],
        ["resolve-cwd", "3.0.0"],
        ["import-local", "3.0.2"],
      ]),
    }],
  ])],
  ["pkg-dir", new Map([
    ["4.2.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-pkg-dir-4.2.0-f099133df7ede422e81d1d8448270eeb3e4261f3-integrity/node_modules/pkg-dir/"),
      packageDependencies: new Map([
        ["find-up", "4.1.0"],
        ["pkg-dir", "4.2.0"],
      ]),
    }],
  ])],
  ["resolve-cwd", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-resolve-cwd-3.0.0-0f0075f1bb2544766cf73ba6a6e2adfebcb13f2d-integrity/node_modules/resolve-cwd/"),
      packageDependencies: new Map([
        ["resolve-from", "5.0.0"],
        ["resolve-cwd", "3.0.0"],
      ]),
    }],
  ])],
  ["jest-cli", new Map([
    ["27.0.6", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-jest-cli-27.0.6-d021e5f4d86d6a212450d4c7b86cb219f1e6864f-integrity/node_modules/jest-cli/"),
      packageDependencies: new Map([
        ["@jest/core", "pnp:009fc831e75ad92f6c70b337416a0184394e915b"],
        ["@jest/test-result", "27.0.6"],
        ["@jest/types", "27.0.6"],
        ["chalk", "4.1.1"],
        ["exit", "0.1.2"],
        ["graceful-fs", "4.2.6"],
        ["import-local", "3.0.2"],
        ["jest-config", "pnp:1d860a5e1d1afe3406204bf0a88934989701a085"],
        ["jest-util", "27.0.6"],
        ["jest-validate", "27.0.6"],
        ["prompts", "2.4.1"],
        ["yargs", "16.2.0"],
        ["jest-cli", "27.0.6"],
      ]),
    }],
  ])],
  ["prompts", new Map([
    ["2.4.1", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-prompts-2.4.1-befd3b1195ba052f9fd2fde8a486c4e82ee77f61-integrity/node_modules/prompts/"),
      packageDependencies: new Map([
        ["kleur", "3.0.3"],
        ["sisteransi", "1.0.5"],
        ["prompts", "2.4.1"],
      ]),
    }],
  ])],
  ["kleur", new Map([
    ["3.0.3", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-kleur-3.0.3-a79c9ecc86ee1ce3fa6206d1216c501f147fc07e-integrity/node_modules/kleur/"),
      packageDependencies: new Map([
        ["kleur", "3.0.3"],
      ]),
    }],
  ])],
  ["sisteransi", new Map([
    ["1.0.5", {
      packageLocation: path.resolve(__dirname, "../../../../Library/Caches/Yarn/v6/npm-sisteransi-1.0.5-134d681297756437cc05ca01370d3a7a571075ed-integrity/node_modules/sisteransi/"),
      packageDependencies: new Map([
        ["sisteransi", "1.0.5"],
      ]),
    }],
  ])],
  [null, new Map([
    [null, {
      packageLocation: path.resolve(__dirname, "./"),
      packageDependencies: new Map([
        ["qs", "6.10.1"],
        ["jest", "27.0.6"],
      ]),
    }],
  ])],
]);

let locatorsByLocations = new Map([
  ["./.pnp/externals/pnp-e16659376c40eeb553199539f43f1f4a408bbc71/node_modules/@jest/core/", blacklistedLocator],
  ["./.pnp/externals/pnp-03d96a41183e83878005f79a497dffac64cad5f8/node_modules/jest-config/", blacklistedLocator],
  ["./.pnp/externals/pnp-41830d6beb45de28115d10519b496c20a033d9cb/node_modules/babel-preset-current-node-syntax/", blacklistedLocator],
  ["./.pnp/externals/pnp-c15c49eefe8107cbd918f51276ff72b26e22b26d/node_modules/babel-preset-current-node-syntax/", blacklistedLocator],
  ["./.pnp/externals/pnp-009fc831e75ad92f6c70b337416a0184394e915b/node_modules/@jest/core/", blacklistedLocator],
  ["./.pnp/externals/pnp-1d860a5e1d1afe3406204bf0a88934989701a085/node_modules/jest-config/", blacklistedLocator],
  ["./.pnp/externals/pnp-0f0e2a91a6379bbdf821c39c6146ea3908288fe2/node_modules/jest-config/", blacklistedLocator],
  ["../../../../Library/Caches/Yarn/v6/npm-qs-6.10.1-4931482fa8d647a5aab799c5271d2133b981fb6a-integrity/node_modules/qs/", {"name":"qs","reference":"6.10.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-side-channel-1.0.4-efce5c8fdc104ee751b25c58d4290011fa5ea2cf-integrity/node_modules/side-channel/", {"name":"side-channel","reference":"1.0.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-call-bind-1.0.2-b1d4e89e688119c3c9a903ad30abb2f6a919be3c-integrity/node_modules/call-bind/", {"name":"call-bind","reference":"1.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-function-bind-1.1.1-a56899d3ea3c9bab874bb9773b7c5ede92f4895d-integrity/node_modules/function-bind/", {"name":"function-bind","reference":"1.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-get-intrinsic-1.1.1-15f59f376f855c446963948f0d24cd3637b4abc6-integrity/node_modules/get-intrinsic/", {"name":"get-intrinsic","reference":"1.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-has-1.0.3-722d7cbfc1f6aa8241f16dd814e011e1f41e8796-integrity/node_modules/has/", {"name":"has","reference":"1.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-has-symbols-1.0.2-165d3070c00309752a1236a479331e3ac56f1423-integrity/node_modules/has-symbols/", {"name":"has-symbols","reference":"1.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-object-inspect-1.10.3-c2aa7d2d09f50c99375704f7a0adf24c5782d369-integrity/node_modules/object-inspect/", {"name":"object-inspect","reference":"1.10.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-27.0.6-10517b2a628f0409087fbf473db44777d7a04505-integrity/node_modules/jest/", {"name":"jest","reference":"27.0.6"}],
  ["./.pnp/externals/pnp-e16659376c40eeb553199539f43f1f4a408bbc71/node_modules/@jest/core/", {"name":"@jest/core","reference":"pnp:e16659376c40eeb553199539f43f1f4a408bbc71"}],
  ["./.pnp/externals/pnp-009fc831e75ad92f6c70b337416a0184394e915b/node_modules/@jest/core/", {"name":"@jest/core","reference":"pnp:009fc831e75ad92f6c70b337416a0184394e915b"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-console-27.0.6-3eb72ea80897495c3d73dd97aab7f26770e2260f-integrity/node_modules/@jest/console/", {"name":"@jest/console","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-types-27.0.6-9a992bc517e0c49f035938b8549719c2de40706b-integrity/node_modules/@jest/types/", {"name":"@jest/types","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-istanbul-lib-coverage-2.0.3-4ba8ddb720221f432e443bd5f9117fd22cfd4762-integrity/node_modules/@types/istanbul-lib-coverage/", {"name":"@types/istanbul-lib-coverage","reference":"2.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-istanbul-reports-3.0.1-9153fe98bba2bd565a63add9436d6f0d7f8468ff-integrity/node_modules/@types/istanbul-reports/", {"name":"@types/istanbul-reports","reference":"3.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-istanbul-lib-report-3.0.0-c14c24f18ea8190c118ee7562b7ff99a36552686-integrity/node_modules/@types/istanbul-lib-report/", {"name":"@types/istanbul-lib-report","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-node-16.3.1-24691fa2b0c3ec8c0d34bfcfd495edac5593ebb4-integrity/node_modules/@types/node/", {"name":"@types/node","reference":"16.3.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-yargs-16.0.4-26aad98dd2c2a38e421086ea9ad42b9e51642977-integrity/node_modules/@types/yargs/", {"name":"@types/yargs","reference":"16.0.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-yargs-parser-20.2.1-3b9ce2489919d9e4fea439b76916abc34b2df129-integrity/node_modules/@types/yargs-parser/", {"name":"@types/yargs-parser","reference":"20.2.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-chalk-4.1.1-c80b3fab28bf6371e6863325eee67e618b77e6ad-integrity/node_modules/chalk/", {"name":"chalk","reference":"4.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-chalk-2.4.2-cd42541677a54333cf541a49108c1432b44c9424-integrity/node_modules/chalk/", {"name":"chalk","reference":"2.4.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-ansi-styles-4.3.0-edd803628ae71c04c85ae7a0906edad34b648937-integrity/node_modules/ansi-styles/", {"name":"ansi-styles","reference":"4.3.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-ansi-styles-3.2.1-41fbb20243e50b12be0f04b8dedbf07520ce841d-integrity/node_modules/ansi-styles/", {"name":"ansi-styles","reference":"3.2.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-ansi-styles-5.2.0-07449690ad45777d1924ac2abb2fc8895dba836b-integrity/node_modules/ansi-styles/", {"name":"ansi-styles","reference":"5.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-color-convert-2.0.1-72d3a68d598c9bdb3af2ad1e84f21d896abd4de3-integrity/node_modules/color-convert/", {"name":"color-convert","reference":"2.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-color-convert-1.9.3-bb71850690e1f136567de629d2d5471deda4c1e8-integrity/node_modules/color-convert/", {"name":"color-convert","reference":"1.9.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-color-name-1.1.4-c2a09a87acbde69543de6f63fa3995c826c536a2-integrity/node_modules/color-name/", {"name":"color-name","reference":"1.1.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-color-name-1.1.3-a7d0558bd89c42f795dd42328f740831ca53bc25-integrity/node_modules/color-name/", {"name":"color-name","reference":"1.1.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-supports-color-7.2.0-1b7dcdcb32b8138801b3e478ba6a51caa89648da-integrity/node_modules/supports-color/", {"name":"supports-color","reference":"7.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-supports-color-5.5.0-e2e69a44ac8772f78a1ec0b35b689df6530efc8f-integrity/node_modules/supports-color/", {"name":"supports-color","reference":"5.5.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-supports-color-8.1.1-cd6fc17e28500cff56c1b86c0a7fd4a54a73005c-integrity/node_modules/supports-color/", {"name":"supports-color","reference":"8.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-has-flag-4.0.0-944771fd9c81c81265c4d6941860da06bb59479b-integrity/node_modules/has-flag/", {"name":"has-flag","reference":"4.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-has-flag-3.0.0-b5d454dc2199ae225699f3467e5a07f3b955bafd-integrity/node_modules/has-flag/", {"name":"has-flag","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-message-util-27.0.6-158bcdf4785706492d164a39abca6a14da5ab8b5-integrity/node_modules/jest-message-util/", {"name":"jest-message-util","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-code-frame-7.14.5-23b08d740e83f49c5e59945fbf1b43e80bbf4edb-integrity/node_modules/@babel/code-frame/", {"name":"@babel/code-frame","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-highlight-7.14.5-6861a52f03966405001f6aa534a01a24d99e8cd9-integrity/node_modules/@babel/highlight/", {"name":"@babel/highlight","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-validator-identifier-7.14.5-d0f0e277c512e0c938277faa85a3968c9a44c0e8-integrity/node_modules/@babel/helper-validator-identifier/", {"name":"@babel/helper-validator-identifier","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-escape-string-regexp-1.0.5-1b61c0562190a8dff6ae3bb2cf0200ca130b86d4-integrity/node_modules/escape-string-regexp/", {"name":"escape-string-regexp","reference":"1.0.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-escape-string-regexp-2.0.0-a30304e99daa32e23b2fd20f51babd07cffca344-integrity/node_modules/escape-string-regexp/", {"name":"escape-string-regexp","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-js-tokens-4.0.0-19203fb59991df98e3a287050d4647cdeaf32499-integrity/node_modules/js-tokens/", {"name":"js-tokens","reference":"4.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-stack-utils-2.0.1-20f18294f797f2209b5f65c8e3b5c8e8261d127c-integrity/node_modules/@types/stack-utils/", {"name":"@types/stack-utils","reference":"2.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-graceful-fs-4.2.6-ff040b2b0853b23c3d31027523706f1885d76bee-integrity/node_modules/graceful-fs/", {"name":"graceful-fs","reference":"4.2.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-micromatch-4.0.4-896d519dfe9db25fce94ceb7a500919bf881ebf9-integrity/node_modules/micromatch/", {"name":"micromatch","reference":"4.0.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-braces-3.0.2-3454e1a462ee8d599e236df336cd9ea4f8afe107-integrity/node_modules/braces/", {"name":"braces","reference":"3.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-fill-range-7.0.1-1919a6a7c75fe38b2c7c77e5198535da9acdda40-integrity/node_modules/fill-range/", {"name":"fill-range","reference":"7.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-to-regex-range-5.0.1-1648c44aae7c8d988a326018ed72f5b4dd0392e4-integrity/node_modules/to-regex-range/", {"name":"to-regex-range","reference":"5.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-is-number-7.0.0-7535345b896734d5f80c4d06c50955527a14f12b-integrity/node_modules/is-number/", {"name":"is-number","reference":"7.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-picomatch-2.3.0-f1f061de8f6a4bf022892e2d128234fb98302972-integrity/node_modules/picomatch/", {"name":"picomatch","reference":"2.3.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-pretty-format-27.0.6-ab770c47b2c6f893a21aefc57b75da63ef49a11f-integrity/node_modules/pretty-format/", {"name":"pretty-format","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-ansi-regex-5.0.0-388539f55179bf39339c81af30a654d69f87cb75-integrity/node_modules/ansi-regex/", {"name":"ansi-regex","reference":"5.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-react-is-17.0.2-e691d4a8e9c789365655539ab372762b0efb54f0-integrity/node_modules/react-is/", {"name":"react-is","reference":"17.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-slash-3.0.0-6539be870c165adbd5240220dbe361f1bc4d4634-integrity/node_modules/slash/", {"name":"slash","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-stack-utils-2.0.3-cd5f030126ff116b78ccb3c027fe302713b61277-integrity/node_modules/stack-utils/", {"name":"stack-utils","reference":"2.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-util-27.0.6-e8e04eec159de2f4d5f57f795df9cdc091e50297-integrity/node_modules/jest-util/", {"name":"jest-util","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-is-ci-3.0.0-c7e7be3c9d8eef7d0fa144390bd1e4b88dc4c994-integrity/node_modules/is-ci/", {"name":"is-ci","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-ci-info-3.2.0-2876cb948a498797b5236f0095bc057d0dca38b6-integrity/node_modules/ci-info/", {"name":"ci-info","reference":"3.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-reporters-27.0.6-91e7f2d98c002ad5df94d5b5167c1eb0b9fd5b00-integrity/node_modules/@jest/reporters/", {"name":"@jest/reporters","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@bcoe-v8-coverage-0.2.3-75a2e8b51cb758a7553d6804a5932d7aace75c39-integrity/node_modules/@bcoe/v8-coverage/", {"name":"@bcoe/v8-coverage","reference":"0.2.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-test-result-27.0.6-3fa42015a14e4fdede6acd042ce98c7f36627051-integrity/node_modules/@jest/test-result/", {"name":"@jest/test-result","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-collect-v8-coverage-1.0.1-cc2c8e94fc18bbdffe64d6534570c8a673b27f59-integrity/node_modules/collect-v8-coverage/", {"name":"collect-v8-coverage","reference":"1.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-transform-27.0.6-189ad7107413208f7600f4719f81dd2f7278cc95-integrity/node_modules/@jest/transform/", {"name":"@jest/transform","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-core-7.14.6-e0814ec1a950032ff16c13a2721de39a8416fcab-integrity/node_modules/@babel/core/", {"name":"@babel/core","reference":"7.14.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-generator-7.14.5-848d7b9f031caca9d0cd0af01b063f226f52d785-integrity/node_modules/@babel/generator/", {"name":"@babel/generator","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-types-7.14.5-3bb997ba829a2104cedb20689c4a5b8121d383ff-integrity/node_modules/@babel/types/", {"name":"@babel/types","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-to-fast-properties-2.0.0-dc5e698cbd079265bc73e0377681a4e4e83f616e-integrity/node_modules/to-fast-properties/", {"name":"to-fast-properties","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jsesc-2.5.2-80564d2e483dacf6e8ef209650a67df3f0c283a4-integrity/node_modules/jsesc/", {"name":"jsesc","reference":"2.5.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-source-map-0.5.7-8a039d2d1021d22d1ea14c80d8ea468ba2ef3fcc-integrity/node_modules/source-map/", {"name":"source-map","reference":"0.5.7"}],
  ["../../../../Library/Caches/Yarn/v6/npm-source-map-0.6.1-74722af32e9614e9c287a8d0bbde48b5e2f1a263-integrity/node_modules/source-map/", {"name":"source-map","reference":"0.6.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-source-map-0.7.3-5302f8169031735226544092e64981f751750383-integrity/node_modules/source-map/", {"name":"source-map","reference":"0.7.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-compilation-targets-7.14.5-7a99c5d0967911e972fe2c3411f7d5b498498ecf-integrity/node_modules/@babel/helper-compilation-targets/", {"name":"@babel/helper-compilation-targets","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-compat-data-7.14.7-7b047d7a3a89a67d2258dc61f604f098f1bc7e08-integrity/node_modules/@babel/compat-data/", {"name":"@babel/compat-data","reference":"7.14.7"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-validator-option-7.14.5-6e72a1fff18d5dfcb878e1e62f1a021c4b72d5a3-integrity/node_modules/@babel/helper-validator-option/", {"name":"@babel/helper-validator-option","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-browserslist-4.16.6-d7901277a5a88e554ed305b183ec9b0c08f66fa2-integrity/node_modules/browserslist/", {"name":"browserslist","reference":"4.16.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-caniuse-lite-1.0.30001243-d9250155c91e872186671c523f3ae50cfc94a3aa-integrity/node_modules/caniuse-lite/", {"name":"caniuse-lite","reference":"1.0.30001243"}],
  ["../../../../Library/Caches/Yarn/v6/npm-colorette-1.2.2-cbcc79d5e99caea2dbf10eb3a26fd8b3e6acfa94-integrity/node_modules/colorette/", {"name":"colorette","reference":"1.2.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-electron-to-chromium-1.3.772-fd1ed39f9f3149f62f581734e4f026e600369479-integrity/node_modules/electron-to-chromium/", {"name":"electron-to-chromium","reference":"1.3.772"}],
  ["../../../../Library/Caches/Yarn/v6/npm-escalade-3.1.1-d8cfdc7000965c5a0174b4a82eaa5c0552742e40-integrity/node_modules/escalade/", {"name":"escalade","reference":"3.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-node-releases-1.1.73-dd4e81ddd5277ff846b80b52bb40c49edf7a7b20-integrity/node_modules/node-releases/", {"name":"node-releases","reference":"1.1.73"}],
  ["../../../../Library/Caches/Yarn/v6/npm-semver-6.3.0-ee0a64c8af5e8ceea67687b133761e1becbd1d3d-integrity/node_modules/semver/", {"name":"semver","reference":"6.3.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-semver-7.3.5-0b621c879348d8998e4b0e4be94b3f12e6018ef7-integrity/node_modules/semver/", {"name":"semver","reference":"7.3.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-module-transforms-7.14.5-7de42f10d789b423eb902ebd24031ca77cb1e10e-integrity/node_modules/@babel/helper-module-transforms/", {"name":"@babel/helper-module-transforms","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-module-imports-7.14.5-6d1a44df6a38c957aa7c312da076429f11b422f3-integrity/node_modules/@babel/helper-module-imports/", {"name":"@babel/helper-module-imports","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-replace-supers-7.14.5-0ecc0b03c41cd567b4024ea016134c28414abb94-integrity/node_modules/@babel/helper-replace-supers/", {"name":"@babel/helper-replace-supers","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-member-expression-to-functions-7.14.7-97e56244beb94211fe277bd818e3a329c66f7970-integrity/node_modules/@babel/helper-member-expression-to-functions/", {"name":"@babel/helper-member-expression-to-functions","reference":"7.14.7"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-optimise-call-expression-7.14.5-f27395a8619e0665b3f0364cddb41c25d71b499c-integrity/node_modules/@babel/helper-optimise-call-expression/", {"name":"@babel/helper-optimise-call-expression","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-traverse-7.14.7-64007c9774cfdc3abd23b0780bc18a3ce3631753-integrity/node_modules/@babel/traverse/", {"name":"@babel/traverse","reference":"7.14.7"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-function-name-7.14.5-89e2c474972f15d8e233b52ee8c480e2cfcd50c4-integrity/node_modules/@babel/helper-function-name/", {"name":"@babel/helper-function-name","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-get-function-arity-7.14.5-25fbfa579b0937eee1f3b805ece4ce398c431815-integrity/node_modules/@babel/helper-get-function-arity/", {"name":"@babel/helper-get-function-arity","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-template-7.14.5-a9bc9d8b33354ff6e55a9c60d1109200a68974f4-integrity/node_modules/@babel/template/", {"name":"@babel/template","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-parser-7.14.7-6099720c8839ca865a2637e6c85852ead0bdb595-integrity/node_modules/@babel/parser/", {"name":"@babel/parser","reference":"7.14.7"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-hoist-variables-7.14.5-e0dd27c33a78e577d7c8884916a3e7ef1f7c7f8d-integrity/node_modules/@babel/helper-hoist-variables/", {"name":"@babel/helper-hoist-variables","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-split-export-declaration-7.14.5-22b23a54ef51c2b7605d851930c1976dd0bc693a-integrity/node_modules/@babel/helper-split-export-declaration/", {"name":"@babel/helper-split-export-declaration","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-debug-4.3.2-f0a49c18ac8779e31d4a0c6029dfb76873c7428b-integrity/node_modules/debug/", {"name":"debug","reference":"4.3.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-ms-2.1.2-d09d1f357b443f493382a8eb3ccd183872ae6009-integrity/node_modules/ms/", {"name":"ms","reference":"2.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-globals-11.12.0-ab8795338868a0babd8525758018c2a7eb95c42e-integrity/node_modules/globals/", {"name":"globals","reference":"11.12.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-simple-access-7.14.5-66ea85cf53ba0b4e588ba77fc813f53abcaa41c4-integrity/node_modules/@babel/helper-simple-access/", {"name":"@babel/helper-simple-access","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helpers-7.14.6-5b58306b95f1b47e2a0199434fa8658fa6c21635-integrity/node_modules/@babel/helpers/", {"name":"@babel/helpers","reference":"7.14.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-convert-source-map-1.8.0-f3373c32d21b4d780dd8004514684fb791ca4369-integrity/node_modules/convert-source-map/", {"name":"convert-source-map","reference":"1.8.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-safe-buffer-5.1.2-991ec69d296e0313747d59bdfd2b745c35f8828d-integrity/node_modules/safe-buffer/", {"name":"safe-buffer","reference":"5.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-gensync-1.0.0-beta.2-32a6ee76c3d7f52d46b2b1ae5d93fea8580a25e0-integrity/node_modules/gensync/", {"name":"gensync","reference":"1.0.0-beta.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-json5-2.2.0-2dfefe720c6ba525d9ebd909950f0515316c89a3-integrity/node_modules/json5/", {"name":"json5","reference":"2.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-minimist-1.2.5-67d66014b66a6a8aaa0c083c5fd58df4e4e97602-integrity/node_modules/minimist/", {"name":"minimist","reference":"1.2.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-babel-plugin-istanbul-6.0.0-e159ccdc9af95e0b570c75b4573b7c34d671d765-integrity/node_modules/babel-plugin-istanbul/", {"name":"babel-plugin-istanbul","reference":"6.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-helper-plugin-utils-7.14.5-5ac822ce97eec46741ab70a517971e443a70c5a9-integrity/node_modules/@babel/helper-plugin-utils/", {"name":"@babel/helper-plugin-utils","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@istanbuljs-load-nyc-config-1.1.0-fd3db1d59ecf7cf121e80650bb86712f9b55eced-integrity/node_modules/@istanbuljs/load-nyc-config/", {"name":"@istanbuljs/load-nyc-config","reference":"1.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-camelcase-5.3.1-e3c9b31569e106811df242f715725a1f4c494320-integrity/node_modules/camelcase/", {"name":"camelcase","reference":"5.3.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-camelcase-6.2.0-924af881c9d525ac9d87f40d964e5cea982a1809-integrity/node_modules/camelcase/", {"name":"camelcase","reference":"6.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-find-up-4.1.0-97afe7d6cdc0bc5928584b7c8d7b16e8a9aa5d19-integrity/node_modules/find-up/", {"name":"find-up","reference":"4.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-locate-path-5.0.0-1afba396afd676a6d42504d0a67a3a7eb9f62aa0-integrity/node_modules/locate-path/", {"name":"locate-path","reference":"5.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-p-locate-4.1.0-a3428bb7088b3a60292f66919278b7c297ad4f07-integrity/node_modules/p-locate/", {"name":"p-locate","reference":"4.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-p-limit-2.3.0-3dd33c647a214fdfffd835933eb086da0dc21db1-integrity/node_modules/p-limit/", {"name":"p-limit","reference":"2.3.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-p-try-2.2.0-cb2868540e313d61de58fafbe35ce9004d5540e6-integrity/node_modules/p-try/", {"name":"p-try","reference":"2.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-path-exists-4.0.0-513bdbe2d3b95d7762e8c1137efa195c6c61b5b3-integrity/node_modules/path-exists/", {"name":"path-exists","reference":"4.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-get-package-type-0.1.0-8de2d803cff44df3bc6c456e6668b36c3926e11a-integrity/node_modules/get-package-type/", {"name":"get-package-type","reference":"0.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-js-yaml-3.14.1-dae812fdb3825fa306609a8717383c50c36a0537-integrity/node_modules/js-yaml/", {"name":"js-yaml","reference":"3.14.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-argparse-1.0.10-bcd6791ea5ae09725e17e5ad988134cd40b3d911-integrity/node_modules/argparse/", {"name":"argparse","reference":"1.0.10"}],
  ["../../../../Library/Caches/Yarn/v6/npm-sprintf-js-1.0.3-04e6926f662895354f3dd015203633b857297e2c-integrity/node_modules/sprintf-js/", {"name":"sprintf-js","reference":"1.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-esprima-4.0.1-13b04cdb3e6c5d19df91ab6987a8695619b0aa71-integrity/node_modules/esprima/", {"name":"esprima","reference":"4.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-resolve-from-5.0.0-c35225843df8f776df21c57557bc087e9dfdfc69-integrity/node_modules/resolve-from/", {"name":"resolve-from","reference":"5.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@istanbuljs-schema-0.1.3-e45e384e4b8ec16bce2fd903af78450f6bf7ec98-integrity/node_modules/@istanbuljs/schema/", {"name":"@istanbuljs/schema","reference":"0.1.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-istanbul-lib-instrument-4.0.3-873c6fff897450118222774696a3f28902d77c1d-integrity/node_modules/istanbul-lib-instrument/", {"name":"istanbul-lib-instrument","reference":"4.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-istanbul-lib-coverage-3.0.0-f5944a37c70b550b02a78a5c3b2055b280cec8ec-integrity/node_modules/istanbul-lib-coverage/", {"name":"istanbul-lib-coverage","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-test-exclude-6.0.0-04a8698661d805ea6fa293b6cb9e63ac044ef15e-integrity/node_modules/test-exclude/", {"name":"test-exclude","reference":"6.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-glob-7.1.7-3b193e9233f01d42d0b3f78294bbeeb418f94a90-integrity/node_modules/glob/", {"name":"glob","reference":"7.1.7"}],
  ["../../../../Library/Caches/Yarn/v6/npm-fs-realpath-1.0.0-1504ad2523158caa40db4a2787cb01411994ea4f-integrity/node_modules/fs.realpath/", {"name":"fs.realpath","reference":"1.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-inflight-1.0.6-49bd6331d7d02d0c09bc910a1075ba8165b56df9-integrity/node_modules/inflight/", {"name":"inflight","reference":"1.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-once-1.4.0-583b1aa775961d4b113ac17d9c50baef9dd76bd1-integrity/node_modules/once/", {"name":"once","reference":"1.4.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-wrappy-1.0.2-b5243d8f3ec1aa35f1364605bc0d1036e30ab69f-integrity/node_modules/wrappy/", {"name":"wrappy","reference":"1.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-inherits-2.0.4-0fa2c64f932917c3433a0ded55363aae37416b7c-integrity/node_modules/inherits/", {"name":"inherits","reference":"2.0.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-minimatch-3.0.4-5166e286457f03306064be5497e8dbb0c3d32083-integrity/node_modules/minimatch/", {"name":"minimatch","reference":"3.0.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-brace-expansion-1.1.11-3c7fcbf529d87226f3d2f52b966ff5271eb441dd-integrity/node_modules/brace-expansion/", {"name":"brace-expansion","reference":"1.1.11"}],
  ["../../../../Library/Caches/Yarn/v6/npm-balanced-match-1.0.2-e83e3a7e3f300b34cb9d87f615fa0cbf357690ee-integrity/node_modules/balanced-match/", {"name":"balanced-match","reference":"1.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-concat-map-0.0.1-d8a96bd77fd68df7793a73036a3ba0d5405d477b-integrity/node_modules/concat-map/", {"name":"concat-map","reference":"0.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-path-is-absolute-1.0.1-174b9268735534ffbc7ace6bf53a5a9e1b5c5f5f-integrity/node_modules/path-is-absolute/", {"name":"path-is-absolute","reference":"1.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-fast-json-stable-stringify-2.1.0-874bf69c6f404c2b5d99c481341399fd55892633-integrity/node_modules/fast-json-stable-stringify/", {"name":"fast-json-stable-stringify","reference":"2.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-haste-map-27.0.6-4683a4e68f6ecaa74231679dca237279562c8dc7-integrity/node_modules/jest-haste-map/", {"name":"jest-haste-map","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-graceful-fs-4.1.5-21ffba0d98da4350db64891f92a9e5db3cdb4e15-integrity/node_modules/@types/graceful-fs/", {"name":"@types/graceful-fs","reference":"4.1.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-anymatch-3.1.2-c0557c096af32f106198f4f4e2a383537e378716-integrity/node_modules/anymatch/", {"name":"anymatch","reference":"3.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-normalize-path-3.0.0-0dcd69ff23a1c9b11fd0978316644a0388216a65-integrity/node_modules/normalize-path/", {"name":"normalize-path","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-fb-watchman-2.0.1-fc84fb39d2709cf3ff6d743706157bb5708a8a85-integrity/node_modules/fb-watchman/", {"name":"fb-watchman","reference":"2.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-bser-2.1.1-e6787da20ece9d07998533cfd9de6f5c38f4bc05-integrity/node_modules/bser/", {"name":"bser","reference":"2.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-node-int64-0.4.0-87a9065cdb355d3182d8f94ce11188b825c68a3b-integrity/node_modules/node-int64/", {"name":"node-int64","reference":"0.4.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-regex-util-27.0.6-02e112082935ae949ce5d13b2675db3d8c87d9c5-integrity/node_modules/jest-regex-util/", {"name":"jest-regex-util","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-serializer-27.0.6-93a6c74e0132b81a2d54623251c46c498bb5bec1-integrity/node_modules/jest-serializer/", {"name":"jest-serializer","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-worker-27.0.6-a5fdb1e14ad34eb228cfe162d9f729cdbfa28aed-integrity/node_modules/jest-worker/", {"name":"jest-worker","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-merge-stream-2.0.0-52823629a14dd00c9770fb6ad47dc6310f2c1f60-integrity/node_modules/merge-stream/", {"name":"merge-stream","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-walker-1.0.7-2f7f9b8fd10d677262b18a884e28d19618e028fb-integrity/node_modules/walker/", {"name":"walker","reference":"1.0.7"}],
  ["../../../../Library/Caches/Yarn/v6/npm-makeerror-1.0.11-e01a5c9109f2af79660e4e8b9587790184f5a96c-integrity/node_modules/makeerror/", {"name":"makeerror","reference":"1.0.11"}],
  ["../../../../Library/Caches/Yarn/v6/npm-tmpl-1.0.4-23640dd7b42d00433911140820e5cf440e521dd1-integrity/node_modules/tmpl/", {"name":"tmpl","reference":"1.0.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-fsevents-2.3.2-8a526f78b8fdf4623b709e0b975c52c24c02fd1a-integrity/node_modules/fsevents/", {"name":"fsevents","reference":"2.3.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-pirates-4.0.1-643a92caf894566f91b2b986d2c66950a8e2fb87-integrity/node_modules/pirates/", {"name":"pirates","reference":"4.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-node-modules-regexp-1.0.0-8d9dbe28964a4ac5712e9131642107c71e90ec40-integrity/node_modules/node-modules-regexp/", {"name":"node-modules-regexp","reference":"1.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-write-file-atomic-3.0.3-56bd5c5a5c70481cd19c571bd39ab965a5de56e8-integrity/node_modules/write-file-atomic/", {"name":"write-file-atomic","reference":"3.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-imurmurhash-0.1.4-9218b9b2b928a238b13dc4fb6b6d576f231453ea-integrity/node_modules/imurmurhash/", {"name":"imurmurhash","reference":"0.1.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-is-typedarray-1.0.0-e479c80858df0c1b11ddda6940f96011fcda4a9a-integrity/node_modules/is-typedarray/", {"name":"is-typedarray","reference":"1.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-signal-exit-3.0.3-a1410c2edd8f077b08b4e253c8eacfcaf057461c-integrity/node_modules/signal-exit/", {"name":"signal-exit","reference":"3.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-typedarray-to-buffer-3.1.5-a97ee7a9ff42691b9f783ff1bc5112fe3fca9080-integrity/node_modules/typedarray-to-buffer/", {"name":"typedarray-to-buffer","reference":"3.1.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-exit-0.1.2-0632638f8d877cc82107d30a0fff1a17cba1cd0c-integrity/node_modules/exit/", {"name":"exit","reference":"0.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-istanbul-lib-report-3.0.0-7518fe52ea44de372f460a76b5ecda9ffb73d8a6-integrity/node_modules/istanbul-lib-report/", {"name":"istanbul-lib-report","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-make-dir-3.1.0-415e967046b3a7f1d185277d84aa58203726a13f-integrity/node_modules/make-dir/", {"name":"make-dir","reference":"3.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-istanbul-lib-source-maps-4.0.0-75743ce6d96bb86dc7ee4352cf6366a23f0b1ad9-integrity/node_modules/istanbul-lib-source-maps/", {"name":"istanbul-lib-source-maps","reference":"4.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-istanbul-reports-3.0.2-d593210e5000683750cb09fc0644e4b6e27fd53b-integrity/node_modules/istanbul-reports/", {"name":"istanbul-reports","reference":"3.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-html-escaper-2.0.2-dfd60027da36a36dfcbe236262c00a5822681453-integrity/node_modules/html-escaper/", {"name":"html-escaper","reference":"2.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-resolve-27.0.6-e90f436dd4f8fbf53f58a91c42344864f8e55bff-integrity/node_modules/jest-resolve/", {"name":"jest-resolve","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-pnp-resolver-1.2.2-b704ac0ae028a89108a4d040b3f919dfddc8e33c-integrity/node_modules/jest-pnp-resolver/", {"name":"jest-pnp-resolver","reference":"1.2.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-validate-27.0.6-930a527c7a951927df269f43b2dc23262457e2a6-integrity/node_modules/jest-validate/", {"name":"jest-validate","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-get-type-27.0.6-0eb5c7f755854279ce9b68a9f1a4122f69047cfe-integrity/node_modules/jest-get-type/", {"name":"jest-get-type","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-leven-3.1.0-77891de834064cccba82ae7842bb6b14a13ed7f2-integrity/node_modules/leven/", {"name":"leven","reference":"3.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-resolve-1.20.0-629a013fb3f70755d6f0b7935cc1c2c5378b1975-integrity/node_modules/resolve/", {"name":"resolve","reference":"1.20.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-is-core-module-2.4.0-8e9fc8e15027b011418026e98f0e6f4d86305cc1-integrity/node_modules/is-core-module/", {"name":"is-core-module","reference":"2.4.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-path-parse-1.0.7-fbc114b60ca42b30d9daf5858e4bd68bbedb6735-integrity/node_modules/path-parse/", {"name":"path-parse","reference":"1.0.7"}],
  ["../../../../Library/Caches/Yarn/v6/npm-string-length-4.0.2-a8a8dc7bd5c1a82b9b3c8b87e125f66871b6e57a-integrity/node_modules/string-length/", {"name":"string-length","reference":"4.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-char-regex-1.0.2-d744358226217f981ed58f479b1d6bcc29545dcf-integrity/node_modules/char-regex/", {"name":"char-regex","reference":"1.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-strip-ansi-6.0.0-0b1571dd7669ccd4f3e06e14ef1eed26225ae532-integrity/node_modules/strip-ansi/", {"name":"strip-ansi","reference":"6.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-terminal-link-2.1.1-14a64a27ab3c0df933ea546fba55f2d078edc994-integrity/node_modules/terminal-link/", {"name":"terminal-link","reference":"2.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-ansi-escapes-4.3.2-6b2291d1db7d98b6521d5f1efa42d0f3a9feb65e-integrity/node_modules/ansi-escapes/", {"name":"ansi-escapes","reference":"4.3.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-type-fest-0.21.3-d260a24b0198436e133fa26a524a6d65fa3b2e37-integrity/node_modules/type-fest/", {"name":"type-fest","reference":"0.21.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-supports-hyperlinks-2.2.0-4f77b42488765891774b70c79babd87f9bd594bb-integrity/node_modules/supports-hyperlinks/", {"name":"supports-hyperlinks","reference":"2.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-v8-to-istanbul-8.0.0-4229f2a99e367f3f018fa1d5c2b8ec684667c69c-integrity/node_modules/v8-to-istanbul/", {"name":"v8-to-istanbul","reference":"8.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-emittery-0.8.1-bb23cc86d03b30aa75a7f734819dee2e1ba70860-integrity/node_modules/emittery/", {"name":"emittery","reference":"0.8.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-changed-files-27.0.6-bed6183fcdea8a285482e3b50a9a7712d49a7a8b-integrity/node_modules/jest-changed-files/", {"name":"jest-changed-files","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-execa-5.1.1-f80ad9cbf4298f7bd1d4c9555c21e93741c411dd-integrity/node_modules/execa/", {"name":"execa","reference":"5.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-cross-spawn-7.0.3-f73a85b9d5d41d045551c177e2882d4ac85728a6-integrity/node_modules/cross-spawn/", {"name":"cross-spawn","reference":"7.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-path-key-3.1.1-581f6ade658cbba65a0d3380de7753295054f375-integrity/node_modules/path-key/", {"name":"path-key","reference":"3.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-shebang-command-2.0.0-ccd0af4f8835fbdc265b82461aaf0c36663f34ea-integrity/node_modules/shebang-command/", {"name":"shebang-command","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-shebang-regex-3.0.0-ae16f1644d873ecad843b0307b143362d4c42172-integrity/node_modules/shebang-regex/", {"name":"shebang-regex","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-which-2.0.2-7c6a8dd0a636a0327e10b59c9286eee93f3f51b1-integrity/node_modules/which/", {"name":"which","reference":"2.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-isexe-2.0.0-e8fbf374dc556ff8947a10dcb0572d633f2cfa10-integrity/node_modules/isexe/", {"name":"isexe","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-get-stream-6.0.1-a262d8eef67aced57c2852ad6167526a43cbf7b7-integrity/node_modules/get-stream/", {"name":"get-stream","reference":"6.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-human-signals-2.1.0-dc91fcba42e4d06e4abaed33b3e7a3c02f514ea0-integrity/node_modules/human-signals/", {"name":"human-signals","reference":"2.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-is-stream-2.0.0-bde9c32680d6fae04129d6ac9d921ce7815f78e3-integrity/node_modules/is-stream/", {"name":"is-stream","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-npm-run-path-4.0.1-b7ecd1e5ed53da8e37a55e1c2269e0b97ed748ea-integrity/node_modules/npm-run-path/", {"name":"npm-run-path","reference":"4.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-onetime-5.1.2-d0e96ebb56b07476df1dd9c4806e5237985ca45e-integrity/node_modules/onetime/", {"name":"onetime","reference":"5.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-mimic-fn-2.1.0-7ed2c2ccccaf84d3ffcb7a69b57711fc2083401b-integrity/node_modules/mimic-fn/", {"name":"mimic-fn","reference":"2.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-strip-final-newline-2.0.0-89b852fb2fcbe936f6f4b3187afb0a12c1ab58ad-integrity/node_modules/strip-final-newline/", {"name":"strip-final-newline","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-throat-6.0.1-d514fedad95740c12c2d7fc70ea863eb51ade375-integrity/node_modules/throat/", {"name":"throat","reference":"6.0.1"}],
  ["./.pnp/externals/pnp-03d96a41183e83878005f79a497dffac64cad5f8/node_modules/jest-config/", {"name":"jest-config","reference":"pnp:03d96a41183e83878005f79a497dffac64cad5f8"}],
  ["./.pnp/externals/pnp-0f0e2a91a6379bbdf821c39c6146ea3908288fe2/node_modules/jest-config/", {"name":"jest-config","reference":"pnp:0f0e2a91a6379bbdf821c39c6146ea3908288fe2"}],
  ["./.pnp/externals/pnp-1d860a5e1d1afe3406204bf0a88934989701a085/node_modules/jest-config/", {"name":"jest-config","reference":"pnp:1d860a5e1d1afe3406204bf0a88934989701a085"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-test-sequencer-27.0.6-80a913ed7a1130545b1cd777ff2735dd3af5d34b-integrity/node_modules/@jest/test-sequencer/", {"name":"@jest/test-sequencer","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-runtime-27.0.6-45877cfcd386afdd4f317def551fc369794c27c9-integrity/node_modules/jest-runtime/", {"name":"jest-runtime","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-environment-27.0.6-ee293fe996db01d7d663b8108fa0e1ff436219d2-integrity/node_modules/@jest/environment/", {"name":"@jest/environment","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-fake-timers-27.0.6-cbad52f3fe6abe30e7acb8cd5fa3466b9588e3df-integrity/node_modules/@jest/fake-timers/", {"name":"@jest/fake-timers","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@sinonjs-fake-timers-7.1.2-2524eae70c4910edccf99b2f4e6efc5894aff7b5-integrity/node_modules/@sinonjs/fake-timers/", {"name":"@sinonjs/fake-timers","reference":"7.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@sinonjs-commons-1.8.3-3802ddd21a50a949b6721ddd72da36e67e7f1b2d-integrity/node_modules/@sinonjs/commons/", {"name":"@sinonjs/commons","reference":"1.8.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-type-detect-4.0.8-7646fb5f18871cfbb7749e69bd39a6388eb7450c-integrity/node_modules/type-detect/", {"name":"type-detect","reference":"4.0.8"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-mock-27.0.6-0efdd40851398307ba16778728f6d34d583e3467-integrity/node_modules/jest-mock/", {"name":"jest-mock","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-globals-27.0.6-48e3903f99a4650673d8657334d13c9caf0e8f82-integrity/node_modules/@jest/globals/", {"name":"@jest/globals","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-expect-27.0.6-a4d74fbe27222c718fff68ef49d78e26a8fd4c05-integrity/node_modules/expect/", {"name":"expect","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-matcher-utils-27.0.6-2a8da1e86c620b39459f4352eaa255f0d43e39a9-integrity/node_modules/jest-matcher-utils/", {"name":"jest-matcher-utils","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-diff-27.0.6-4a7a19ee6f04ad70e0e3388f35829394a44c7b5e-integrity/node_modules/jest-diff/", {"name":"jest-diff","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-diff-sequences-27.0.6-3305cb2e55a033924054695cc66019fd7f8e5723-integrity/node_modules/diff-sequences/", {"name":"diff-sequences","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@jest-source-map-27.0.6-be9e9b93565d49b0548b86e232092491fb60551f-integrity/node_modules/@jest/source-map/", {"name":"@jest/source-map","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-callsites-3.1.0-b3630abd8943432f54b3f0519238e33cd7df2f73-integrity/node_modules/callsites/", {"name":"callsites","reference":"3.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-cjs-module-lexer-1.2.1-2fd46d9906a126965aa541345c499aaa18e8cd73-integrity/node_modules/cjs-module-lexer/", {"name":"cjs-module-lexer","reference":"1.2.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-snapshot-27.0.6-f4e6b208bd2e92e888344d78f0f650bcff05a4bf-integrity/node_modules/jest-snapshot/", {"name":"jest-snapshot","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-typescript-7.14.5-b82c6ce471b165b5ce420cf92914d6fb46225716-integrity/node_modules/@babel/plugin-syntax-typescript/", {"name":"@babel/plugin-syntax-typescript","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-babel-traverse-7.14.2-ffcd470bbb3f8bf30481678fb5502278ca833a43-integrity/node_modules/@types/babel__traverse/", {"name":"@types/babel__traverse","reference":"7.14.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-prettier-2.3.2-fc8c2825e4ed2142473b4a81064e6e081463d1b3-integrity/node_modules/@types/prettier/", {"name":"@types/prettier","reference":"2.3.2"}],
  ["./.pnp/externals/pnp-41830d6beb45de28115d10519b496c20a033d9cb/node_modules/babel-preset-current-node-syntax/", {"name":"babel-preset-current-node-syntax","reference":"pnp:41830d6beb45de28115d10519b496c20a033d9cb"}],
  ["./.pnp/externals/pnp-c15c49eefe8107cbd918f51276ff72b26e22b26d/node_modules/babel-preset-current-node-syntax/", {"name":"babel-preset-current-node-syntax","reference":"pnp:c15c49eefe8107cbd918f51276ff72b26e22b26d"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-async-generators-7.8.4-a983fb1aeb2ec3f6ed042a210f640e90e786fe0d-integrity/node_modules/@babel/plugin-syntax-async-generators/", {"name":"@babel/plugin-syntax-async-generators","reference":"7.8.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-bigint-7.8.3-4c9a6f669f5d0cdf1b90a1671e9a146be5300cea-integrity/node_modules/@babel/plugin-syntax-bigint/", {"name":"@babel/plugin-syntax-bigint","reference":"7.8.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-class-properties-7.12.13-b5c987274c4a3a82b89714796931a6b53544ae10-integrity/node_modules/@babel/plugin-syntax-class-properties/", {"name":"@babel/plugin-syntax-class-properties","reference":"7.12.13"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-import-meta-7.10.4-ee601348c370fa334d2207be158777496521fd51-integrity/node_modules/@babel/plugin-syntax-import-meta/", {"name":"@babel/plugin-syntax-import-meta","reference":"7.10.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-json-strings-7.8.3-01ca21b668cd8218c9e640cb6dd88c5412b2c96a-integrity/node_modules/@babel/plugin-syntax-json-strings/", {"name":"@babel/plugin-syntax-json-strings","reference":"7.8.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-logical-assignment-operators-7.10.4-ca91ef46303530448b906652bac2e9fe9941f699-integrity/node_modules/@babel/plugin-syntax-logical-assignment-operators/", {"name":"@babel/plugin-syntax-logical-assignment-operators","reference":"7.10.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-nullish-coalescing-operator-7.8.3-167ed70368886081f74b5c36c65a88c03b66d1a9-integrity/node_modules/@babel/plugin-syntax-nullish-coalescing-operator/", {"name":"@babel/plugin-syntax-nullish-coalescing-operator","reference":"7.8.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-numeric-separator-7.10.4-b9b070b3e33570cd9fd07ba7fa91c0dd37b9af97-integrity/node_modules/@babel/plugin-syntax-numeric-separator/", {"name":"@babel/plugin-syntax-numeric-separator","reference":"7.10.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-object-rest-spread-7.8.3-60e225edcbd98a640332a2e72dd3e66f1af55871-integrity/node_modules/@babel/plugin-syntax-object-rest-spread/", {"name":"@babel/plugin-syntax-object-rest-spread","reference":"7.8.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-optional-catch-binding-7.8.3-6111a265bcfb020eb9efd0fdfd7d26402b9ed6c1-integrity/node_modules/@babel/plugin-syntax-optional-catch-binding/", {"name":"@babel/plugin-syntax-optional-catch-binding","reference":"7.8.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-optional-chaining-7.8.3-4f69c2ab95167e0180cd5336613f8c5788f7d48a-integrity/node_modules/@babel/plugin-syntax-optional-chaining/", {"name":"@babel/plugin-syntax-optional-chaining","reference":"7.8.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@babel-plugin-syntax-top-level-await-7.14.5-c1cfdadc35a646240001f06138247b741c34d94c-integrity/node_modules/@babel/plugin-syntax-top-level-await/", {"name":"@babel/plugin-syntax-top-level-await","reference":"7.14.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-natural-compare-1.4.0-4abebfeed7541f2c27acfb29bdbbd15c8d5ba4f7-integrity/node_modules/natural-compare/", {"name":"natural-compare","reference":"1.4.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-lru-cache-6.0.0-6d6fe6570ebd96aaf90fcad1dafa3b2566db3a94-integrity/node_modules/lru-cache/", {"name":"lru-cache","reference":"6.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-yallist-4.0.0-9bb92790d9c0effec63be73519e11a35019a3a72-integrity/node_modules/yallist/", {"name":"yallist","reference":"4.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-strip-bom-4.0.0-9c3505c1db45bcedca3d9cf7a16f5c5aa3901878-integrity/node_modules/strip-bom/", {"name":"strip-bom","reference":"4.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-yargs-16.2.0-1c82bf0f6b6a66eafce7ef30e376f49a12477f66-integrity/node_modules/yargs/", {"name":"yargs","reference":"16.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-cliui-7.0.4-a0265ee655476fc807aea9df3df8df7783808b4f-integrity/node_modules/cliui/", {"name":"cliui","reference":"7.0.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-string-width-4.2.2-dafd4f9559a7585cfba529c6a0a4f73488ebd4c5-integrity/node_modules/string-width/", {"name":"string-width","reference":"4.2.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-emoji-regex-8.0.0-e818fd69ce5ccfcb404594f842963bf53164cc37-integrity/node_modules/emoji-regex/", {"name":"emoji-regex","reference":"8.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-is-fullwidth-code-point-3.0.0-f116f8064fe90b3f7844a38997c0b75051269f1d-integrity/node_modules/is-fullwidth-code-point/", {"name":"is-fullwidth-code-point","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-wrap-ansi-7.0.0-67e145cff510a6a6984bdf1152911d69d2eb9e43-integrity/node_modules/wrap-ansi/", {"name":"wrap-ansi","reference":"7.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-get-caller-file-2.0.5-4f94412a82db32f36e3b0b9741f8a97feb031f7e-integrity/node_modules/get-caller-file/", {"name":"get-caller-file","reference":"2.0.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-require-directory-2.1.1-8c64ad5fd30dab1c976e2344ffe7f792a6a6df42-integrity/node_modules/require-directory/", {"name":"require-directory","reference":"2.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-y18n-5.0.8-7f4934d0f7ca8c56f95314939ddcd2dd91ce1d55-integrity/node_modules/y18n/", {"name":"y18n","reference":"5.0.8"}],
  ["../../../../Library/Caches/Yarn/v6/npm-yargs-parser-20.2.9-2eb7dc3b0289718fc295f362753845c41a0c94ee-integrity/node_modules/yargs-parser/", {"name":"yargs-parser","reference":"20.2.9"}],
  ["../../../../Library/Caches/Yarn/v6/npm-babel-jest-27.0.6-e99c6e0577da2655118e3608b68761a5a69bd0d8-integrity/node_modules/babel-jest/", {"name":"babel-jest","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-babel-core-7.1.15-2ccfb1ad55a02c83f8e0ad327cbc332f55eb1024-integrity/node_modules/@types/babel__core/", {"name":"@types/babel__core","reference":"7.1.15"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-babel-generator-7.6.3-f456b4b2ce79137f768aa130d2423d2f0ccfaba5-integrity/node_modules/@types/babel__generator/", {"name":"@types/babel__generator","reference":"7.6.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@types-babel-template-7.4.1-3d1a48fd9d6c0edfd56f2ff578daed48f36c8969-integrity/node_modules/@types/babel__template/", {"name":"@types/babel__template","reference":"7.4.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-babel-preset-jest-27.0.6-909ef08e9f24a4679768be2f60a3df0856843f9d-integrity/node_modules/babel-preset-jest/", {"name":"babel-preset-jest","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-babel-plugin-jest-hoist-27.0.6-f7c6b3d764af21cb4a2a1ab6870117dbde15b456-integrity/node_modules/babel-plugin-jest-hoist/", {"name":"babel-plugin-jest-hoist","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-deepmerge-4.2.2-44d2ea3679b8f4d4ffba33f03d865fc1e7bf4955-integrity/node_modules/deepmerge/", {"name":"deepmerge","reference":"4.2.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-circus-27.0.6-dd4df17c4697db6a2c232aaad4e9cec666926668-integrity/node_modules/jest-circus/", {"name":"jest-circus","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-co-4.6.0-6ea6bdf3d853ae54ccb8e47bfa0bf3f9031fb184-integrity/node_modules/co/", {"name":"co","reference":"4.6.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-dedent-0.7.0-2495ddbaf6eb874abb0e1be9df22d2e5a544326c-integrity/node_modules/dedent/", {"name":"dedent","reference":"0.7.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-is-generator-fn-2.1.0-7d140adc389aaf3011a8f2a2a4cfa6faadffb118-integrity/node_modules/is-generator-fn/", {"name":"is-generator-fn","reference":"2.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-each-27.0.6-cee117071b04060158dc8d9a66dc50ad40ef453b-integrity/node_modules/jest-each/", {"name":"jest-each","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-environment-jsdom-27.0.6-f66426c4c9950807d0a9f209c590ce544f73291f-integrity/node_modules/jest-environment-jsdom/", {"name":"jest-environment-jsdom","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jsdom-16.6.0-f79b3786682065492a3da6a60a4695da983805ac-integrity/node_modules/jsdom/", {"name":"jsdom","reference":"16.6.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-abab-2.0.5-c0b678fb32d60fc1219c784d6a826fe385aeb79a-integrity/node_modules/abab/", {"name":"abab","reference":"2.0.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-acorn-8.4.1-56c36251fc7cabc7096adc18f05afe814321a28c-integrity/node_modules/acorn/", {"name":"acorn","reference":"8.4.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-acorn-7.4.1-feaed255973d2e77555b83dbc08851a6c63520fa-integrity/node_modules/acorn/", {"name":"acorn","reference":"7.4.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-acorn-globals-6.0.0-46cdd39f0f8ff08a876619b55f5ac8a6dc770b45-integrity/node_modules/acorn-globals/", {"name":"acorn-globals","reference":"6.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-acorn-walk-7.2.0-0de889a601203909b0fbe07b8938dc21d2e967bc-integrity/node_modules/acorn-walk/", {"name":"acorn-walk","reference":"7.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-cssom-0.4.4-5a66cf93d2d0b661d80bf6a44fb65f5c2e4e0a10-integrity/node_modules/cssom/", {"name":"cssom","reference":"0.4.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-cssom-0.3.8-9f1276f5b2b463f2114d3f2c75250af8c1a36f4a-integrity/node_modules/cssom/", {"name":"cssom","reference":"0.3.8"}],
  ["../../../../Library/Caches/Yarn/v6/npm-cssstyle-2.3.0-ff665a0ddbdc31864b09647f34163443d90b0852-integrity/node_modules/cssstyle/", {"name":"cssstyle","reference":"2.3.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-data-urls-2.0.0-156485a72963a970f5d5821aaf642bef2bf2db9b-integrity/node_modules/data-urls/", {"name":"data-urls","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-whatwg-mimetype-2.3.0-3d4b1e0312d2079879f826aff18dbeeca5960fbf-integrity/node_modules/whatwg-mimetype/", {"name":"whatwg-mimetype","reference":"2.3.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-whatwg-url-8.7.0-656a78e510ff8f3937bc0bcbe9f5c0ac35941b77-integrity/node_modules/whatwg-url/", {"name":"whatwg-url","reference":"8.7.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-lodash-4.17.21-679591c564c3bffaae8454cf0b3df370c3d6911c-integrity/node_modules/lodash/", {"name":"lodash","reference":"4.17.21"}],
  ["../../../../Library/Caches/Yarn/v6/npm-tr46-2.1.0-fa87aa81ca5d5941da8cbf1f9b749dc969a4e240-integrity/node_modules/tr46/", {"name":"tr46","reference":"2.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-punycode-2.1.1-b58b010ac40c22c5657616c8d2c2c02c7bf479ec-integrity/node_modules/punycode/", {"name":"punycode","reference":"2.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-webidl-conversions-6.1.0-9111b4d7ea80acd40f5270d666621afa78b69514-integrity/node_modules/webidl-conversions/", {"name":"webidl-conversions","reference":"6.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-webidl-conversions-5.0.0-ae59c8a00b121543a2acc65c0434f57b0fc11aff-integrity/node_modules/webidl-conversions/", {"name":"webidl-conversions","reference":"5.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-decimal-js-10.3.1-d8c3a444a9c6774ba60ca6ad7261c3a94fd5e783-integrity/node_modules/decimal.js/", {"name":"decimal.js","reference":"10.3.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-domexception-2.0.1-fb44aefba793e1574b0af6aed2801d057529f304-integrity/node_modules/domexception/", {"name":"domexception","reference":"2.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-escodegen-2.0.0-5e32b12833e8aa8fa35e1bf0befa89380484c7dd-integrity/node_modules/escodegen/", {"name":"escodegen","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-estraverse-5.2.0-307df42547e6cc7324d3cf03c155d5cdb8c53880-integrity/node_modules/estraverse/", {"name":"estraverse","reference":"5.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-esutils-2.0.3-74d2eb4de0b8da1293711910d50775b9b710ef64-integrity/node_modules/esutils/", {"name":"esutils","reference":"2.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-optionator-0.8.3-84fa1d036fe9d3c7e21d99884b601167ec8fb495-integrity/node_modules/optionator/", {"name":"optionator","reference":"0.8.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-deep-is-0.1.3-b369d6fb5dbc13eecf524f91b070feedc357cf34-integrity/node_modules/deep-is/", {"name":"deep-is","reference":"0.1.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-fast-levenshtein-2.0.6-3d8a5c66883a16a30ca8643e851f19baa7797917-integrity/node_modules/fast-levenshtein/", {"name":"fast-levenshtein","reference":"2.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-levn-0.3.0-3b09924edf9f083c0490fdd4c0bc4421e04764ee-integrity/node_modules/levn/", {"name":"levn","reference":"0.3.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-prelude-ls-1.1.2-21932a549f5e52ffd9a827f570e04be62a97da54-integrity/node_modules/prelude-ls/", {"name":"prelude-ls","reference":"1.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-type-check-0.3.2-5884cab512cf1d355e3fb784f30804b2b520db72-integrity/node_modules/type-check/", {"name":"type-check","reference":"0.3.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-word-wrap-1.2.3-610636f6b1f703891bd34771ccb17fb93b47079c-integrity/node_modules/word-wrap/", {"name":"word-wrap","reference":"1.2.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-form-data-3.0.1-ebd53791b78356a99af9a300d4282c4d5eb9755f-integrity/node_modules/form-data/", {"name":"form-data","reference":"3.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-asynckit-0.4.0-c79ed97f7f34cb8f2ba1bc9790bcc366474b4b79-integrity/node_modules/asynckit/", {"name":"asynckit","reference":"0.4.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-combined-stream-1.0.8-c3d45a8b34fd730631a110a8a2520682b31d5a7f-integrity/node_modules/combined-stream/", {"name":"combined-stream","reference":"1.0.8"}],
  ["../../../../Library/Caches/Yarn/v6/npm-delayed-stream-1.0.0-df3ae199acadfb7d440aaae0b29e2272b24ec619-integrity/node_modules/delayed-stream/", {"name":"delayed-stream","reference":"1.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-mime-types-2.1.31-a00d76b74317c61f9c2db2218b8e9f8e9c5c9e6b-integrity/node_modules/mime-types/", {"name":"mime-types","reference":"2.1.31"}],
  ["../../../../Library/Caches/Yarn/v6/npm-mime-db-1.48.0-e35b31045dd7eada3aaad537ed88a33afbef2d1d-integrity/node_modules/mime-db/", {"name":"mime-db","reference":"1.48.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-html-encoding-sniffer-2.0.1-42a6dc4fd33f00281176e8b23759ca4e4fa185f3-integrity/node_modules/html-encoding-sniffer/", {"name":"html-encoding-sniffer","reference":"2.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-whatwg-encoding-1.0.5-5abacf777c32166a51d085d6b4f3e7d27113ddb0-integrity/node_modules/whatwg-encoding/", {"name":"whatwg-encoding","reference":"1.0.5"}],
  ["../../../../Library/Caches/Yarn/v6/npm-iconv-lite-0.4.24-2022b4b25fbddc21d2f524974a474aafe733908b-integrity/node_modules/iconv-lite/", {"name":"iconv-lite","reference":"0.4.24"}],
  ["../../../../Library/Caches/Yarn/v6/npm-safer-buffer-2.1.2-44fa161b0187b9549dd84bb91802f9bd8385cd6a-integrity/node_modules/safer-buffer/", {"name":"safer-buffer","reference":"2.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-http-proxy-agent-4.0.1-8a8c8ef7f5932ccf953c296ca8291b95aa74aa3a-integrity/node_modules/http-proxy-agent/", {"name":"http-proxy-agent","reference":"4.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-@tootallnate-once-1.1.2-ccb91445360179a04e7fe6aff78c00ffc1eeaf82-integrity/node_modules/@tootallnate/once/", {"name":"@tootallnate/once","reference":"1.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-agent-base-6.0.2-49fff58577cfee3f37176feab4c22e00f86d7f77-integrity/node_modules/agent-base/", {"name":"agent-base","reference":"6.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-https-proxy-agent-5.0.0-e2a90542abb68a762e0a0850f6c9edadfd8506b2-integrity/node_modules/https-proxy-agent/", {"name":"https-proxy-agent","reference":"5.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-is-potential-custom-element-name-1.0.1-171ed6f19e3ac554394edf78caa05784a45bebb5-integrity/node_modules/is-potential-custom-element-name/", {"name":"is-potential-custom-element-name","reference":"1.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-nwsapi-2.2.0-204879a9e3d068ff2a55139c2c772780681a38b7-integrity/node_modules/nwsapi/", {"name":"nwsapi","reference":"2.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-parse5-6.0.1-e1a1c085c569b3dc08321184f19a39cc27f7c30b-integrity/node_modules/parse5/", {"name":"parse5","reference":"6.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-saxes-5.0.1-eebab953fa3b7608dbe94e5dadb15c888fa6696d-integrity/node_modules/saxes/", {"name":"saxes","reference":"5.0.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-xmlchars-2.2.0-060fe1bcb7f9c76fe2a17db86a9bc3ab894210cb-integrity/node_modules/xmlchars/", {"name":"xmlchars","reference":"2.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-symbol-tree-3.2.4-430637d248ba77e078883951fb9aa0eed7c63fa2-integrity/node_modules/symbol-tree/", {"name":"symbol-tree","reference":"3.2.4"}],
  ["../../../../Library/Caches/Yarn/v6/npm-tough-cookie-4.0.0-d822234eeca882f991f0f908824ad2622ddbece4-integrity/node_modules/tough-cookie/", {"name":"tough-cookie","reference":"4.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-psl-1.8.0-9326f8bcfb013adcc005fdff056acce020e51c24-integrity/node_modules/psl/", {"name":"psl","reference":"1.8.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-universalify-0.1.2-b646f69be3942dabcecc9d6639c80dc105efaa66-integrity/node_modules/universalify/", {"name":"universalify","reference":"0.1.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-w3c-hr-time-1.0.2-0a89cdf5cc15822df9c360543676963e0cc308cd-integrity/node_modules/w3c-hr-time/", {"name":"w3c-hr-time","reference":"1.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-browser-process-hrtime-1.0.0-3c9b4b7d782c8121e56f10106d84c0d0ffc94626-integrity/node_modules/browser-process-hrtime/", {"name":"browser-process-hrtime","reference":"1.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-w3c-xmlserializer-2.0.0-3e7104a05b75146cc60f564380b7f683acf1020a-integrity/node_modules/w3c-xmlserializer/", {"name":"w3c-xmlserializer","reference":"2.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-xml-name-validator-3.0.0-6ae73e06de4d8c6e47f9fb181f78d648ad457c6a-integrity/node_modules/xml-name-validator/", {"name":"xml-name-validator","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-ws-7.5.3-160835b63c7d97bfab418fc1b8a9fced2ac01a74-integrity/node_modules/ws/", {"name":"ws","reference":"7.5.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-environment-node-27.0.6-a6699b7ceb52e8d68138b9808b0c404e505f3e07-integrity/node_modules/jest-environment-node/", {"name":"jest-environment-node","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-jasmine2-27.0.6-fd509a9ed3d92bd6edb68a779f4738b100655b37-integrity/node_modules/jest-jasmine2/", {"name":"jest-jasmine2","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-runner-27.0.6-1325f45055539222bbc7256a6976e993ad2f9520-integrity/node_modules/jest-runner/", {"name":"jest-runner","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-docblock-27.0.6-cc78266acf7fe693ca462cbbda0ea4e639e4e5f3-integrity/node_modules/jest-docblock/", {"name":"jest-docblock","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-detect-newline-3.1.0-576f5dfc63ae1a192ff192d8ad3af6308991b651-integrity/node_modules/detect-newline/", {"name":"detect-newline","reference":"3.1.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-leak-detector-27.0.6-545854275f85450d4ef4b8fe305ca2a26450450f-integrity/node_modules/jest-leak-detector/", {"name":"jest-leak-detector","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-source-map-support-0.5.19-a98b62f86dcaf4f67399648c085291ab9e8fed61-integrity/node_modules/source-map-support/", {"name":"source-map-support","reference":"0.5.19"}],
  ["../../../../Library/Caches/Yarn/v6/npm-buffer-from-1.1.1-32713bc028f75c02fdb710d7c7bcec1f2c6070ef-integrity/node_modules/buffer-from/", {"name":"buffer-from","reference":"1.1.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-resolve-dependencies-27.0.6-3e619e0ef391c3ecfcf6ef4056207a3d2be3269f-integrity/node_modules/jest-resolve-dependencies/", {"name":"jest-resolve-dependencies","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-watcher-27.0.6-89526f7f9edf1eac4e4be989bcb6dec6b8878d9c-integrity/node_modules/jest-watcher/", {"name":"jest-watcher","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-p-each-series-2.2.0-105ab0357ce72b202a8a8b94933672657b5e2a9a-integrity/node_modules/p-each-series/", {"name":"p-each-series","reference":"2.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-rimraf-3.0.2-f1a5402ba6220ad52cc1282bac1ae3aa49fd061a-integrity/node_modules/rimraf/", {"name":"rimraf","reference":"3.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-import-local-3.0.2-a8cfd0431d1de4a2199703d003e3e62364fa6db6-integrity/node_modules/import-local/", {"name":"import-local","reference":"3.0.2"}],
  ["../../../../Library/Caches/Yarn/v6/npm-pkg-dir-4.2.0-f099133df7ede422e81d1d8448270eeb3e4261f3-integrity/node_modules/pkg-dir/", {"name":"pkg-dir","reference":"4.2.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-resolve-cwd-3.0.0-0f0075f1bb2544766cf73ba6a6e2adfebcb13f2d-integrity/node_modules/resolve-cwd/", {"name":"resolve-cwd","reference":"3.0.0"}],
  ["../../../../Library/Caches/Yarn/v6/npm-jest-cli-27.0.6-d021e5f4d86d6a212450d4c7b86cb219f1e6864f-integrity/node_modules/jest-cli/", {"name":"jest-cli","reference":"27.0.6"}],
  ["../../../../Library/Caches/Yarn/v6/npm-prompts-2.4.1-befd3b1195ba052f9fd2fde8a486c4e82ee77f61-integrity/node_modules/prompts/", {"name":"prompts","reference":"2.4.1"}],
  ["../../../../Library/Caches/Yarn/v6/npm-kleur-3.0.3-a79c9ecc86ee1ce3fa6206d1216c501f147fc07e-integrity/node_modules/kleur/", {"name":"kleur","reference":"3.0.3"}],
  ["../../../../Library/Caches/Yarn/v6/npm-sisteransi-1.0.5-134d681297756437cc05ca01370d3a7a571075ed-integrity/node_modules/sisteransi/", {"name":"sisteransi","reference":"1.0.5"}],
  ["./", topLevelLocator],
]);
exports.findPackageLocator = function findPackageLocator(location) {
  let relativeLocation = normalizePath(path.relative(__dirname, location));

  if (!relativeLocation.match(isStrictRegExp))
    relativeLocation = `./${relativeLocation}`;

  if (location.match(isDirRegExp) && relativeLocation.charAt(relativeLocation.length - 1) !== '/')
    relativeLocation = `${relativeLocation}/`;

  let match;

  if (relativeLocation.length >= 210 && relativeLocation[209] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 210)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 207 && relativeLocation[206] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 207)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 200 && relativeLocation[199] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 200)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 197 && relativeLocation[196] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 197)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 189 && relativeLocation[188] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 189)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 188 && relativeLocation[187] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 188)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 187 && relativeLocation[186] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 187)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 185 && relativeLocation[184] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 185)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 184 && relativeLocation[183] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 184)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 180 && relativeLocation[179] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 180)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 178 && relativeLocation[177] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 178)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 177 && relativeLocation[176] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 177)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 176 && relativeLocation[175] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 176)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 175 && relativeLocation[174] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 175)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 174 && relativeLocation[173] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 174)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 172 && relativeLocation[171] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 172)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 170 && relativeLocation[169] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 170)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 168 && relativeLocation[167] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 168)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 167 && relativeLocation[166] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 167)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 166 && relativeLocation[165] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 166)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 165 && relativeLocation[164] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 165)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 164 && relativeLocation[163] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 164)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 163 && relativeLocation[162] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 163)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 162 && relativeLocation[161] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 162)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 159 && relativeLocation[158] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 159)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 158 && relativeLocation[157] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 158)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 157 && relativeLocation[156] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 157)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 156 && relativeLocation[155] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 156)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 155 && relativeLocation[154] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 155)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 154 && relativeLocation[153] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 154)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 153 && relativeLocation[152] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 153)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 152 && relativeLocation[151] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 152)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 151 && relativeLocation[150] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 151)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 150 && relativeLocation[149] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 150)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 149 && relativeLocation[148] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 149)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 148 && relativeLocation[147] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 148)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 147 && relativeLocation[146] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 147)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 146 && relativeLocation[145] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 146)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 145 && relativeLocation[144] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 145)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 144 && relativeLocation[143] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 144)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 143 && relativeLocation[142] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 143)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 142 && relativeLocation[141] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 142)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 141 && relativeLocation[140] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 141)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 140 && relativeLocation[139] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 140)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 139 && relativeLocation[138] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 139)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 138 && relativeLocation[137] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 138)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 137 && relativeLocation[136] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 137)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 136 && relativeLocation[135] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 136)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 135 && relativeLocation[134] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 135)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 134 && relativeLocation[133] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 134)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 133 && relativeLocation[132] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 133)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 132 && relativeLocation[131] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 132)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 131 && relativeLocation[130] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 131)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 130 && relativeLocation[129] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 130)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 129 && relativeLocation[128] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 129)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 128 && relativeLocation[127] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 128)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 127 && relativeLocation[126] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 127)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 126 && relativeLocation[125] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 126)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 125 && relativeLocation[124] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 125)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 124 && relativeLocation[123] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 124)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 123 && relativeLocation[122] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 123)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 122 && relativeLocation[121] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 122)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 121 && relativeLocation[120] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 121)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 120 && relativeLocation[119] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 120)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 119 && relativeLocation[118] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 119)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 117 && relativeLocation[116] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 117)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 116 && relativeLocation[115] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 116)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 115 && relativeLocation[114] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 115)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 108 && relativeLocation[107] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 108)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 87 && relativeLocation[86] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 87)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 86 && relativeLocation[85] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 86)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 2 && relativeLocation[1] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 2)))
      return blacklistCheck(match);

  return null;
};


/**
 * Returns the module that should be used to resolve require calls. It's usually the direct parent, except if we're
 * inside an eval expression.
 */

function getIssuerModule(parent) {
  let issuer = parent;

  while (issuer && (issuer.id === '[eval]' || issuer.id === '<repl>' || !issuer.filename)) {
    issuer = issuer.parent;
  }

  return issuer;
}

/**
 * Returns information about a package in a safe way (will throw if they cannot be retrieved)
 */

function getPackageInformationSafe(packageLocator) {
  const packageInformation = exports.getPackageInformation(packageLocator);

  if (!packageInformation) {
    throw makeError(
      `INTERNAL`,
      `Couldn't find a matching entry in the dependency tree for the specified parent (this is probably an internal error)`
    );
  }

  return packageInformation;
}

/**
 * Implements the node resolution for folder access and extension selection
 */

function applyNodeExtensionResolution(unqualifiedPath, {extensions}) {
  // We use this "infinite while" so that we can restart the process as long as we hit package folders
  while (true) {
    let stat;

    try {
      stat = statSync(unqualifiedPath);
    } catch (error) {}

    // If the file exists and is a file, we can stop right there

    if (stat && !stat.isDirectory()) {
      // If the very last component of the resolved path is a symlink to a file, we then resolve it to a file. We only
      // do this first the last component, and not the rest of the path! This allows us to support the case of bin
      // symlinks, where a symlink in "/xyz/pkg-name/.bin/bin-name" will point somewhere else (like "/xyz/pkg-name/index.js").
      // In such a case, we want relative requires to be resolved relative to "/xyz/pkg-name/" rather than "/xyz/pkg-name/.bin/".
      //
      // Also note that the reason we must use readlink on the last component (instead of realpath on the whole path)
      // is that we must preserve the other symlinks, in particular those used by pnp to deambiguate packages using
      // peer dependencies. For example, "/xyz/.pnp/local/pnp-01234569/.bin/bin-name" should see its relative requires
      // be resolved relative to "/xyz/.pnp/local/pnp-0123456789/" rather than "/xyz/pkg-with-peers/", because otherwise
      // we would lose the information that would tell us what are the dependencies of pkg-with-peers relative to its
      // ancestors.

      if (lstatSync(unqualifiedPath).isSymbolicLink()) {
        unqualifiedPath = path.normalize(path.resolve(path.dirname(unqualifiedPath), readlinkSync(unqualifiedPath)));
      }

      return unqualifiedPath;
    }

    // If the file is a directory, we must check if it contains a package.json with a "main" entry

    if (stat && stat.isDirectory()) {
      let pkgJson;

      try {
        pkgJson = JSON.parse(readFileSync(`${unqualifiedPath}/package.json`, 'utf-8'));
      } catch (error) {}

      let nextUnqualifiedPath;

      if (pkgJson && pkgJson.main) {
        nextUnqualifiedPath = path.resolve(unqualifiedPath, pkgJson.main);
      }

      // If the "main" field changed the path, we start again from this new location

      if (nextUnqualifiedPath && nextUnqualifiedPath !== unqualifiedPath) {
        const resolution = applyNodeExtensionResolution(nextUnqualifiedPath, {extensions});

        if (resolution !== null) {
          return resolution;
        }
      }
    }

    // Otherwise we check if we find a file that match one of the supported extensions

    const qualifiedPath = extensions
      .map(extension => {
        return `${unqualifiedPath}${extension}`;
      })
      .find(candidateFile => {
        return existsSync(candidateFile);
      });

    if (qualifiedPath) {
      return qualifiedPath;
    }

    // Otherwise, we check if the path is a folder - in such a case, we try to use its index

    if (stat && stat.isDirectory()) {
      const indexPath = extensions
        .map(extension => {
          return `${unqualifiedPath}/index${extension}`;
        })
        .find(candidateFile => {
          return existsSync(candidateFile);
        });

      if (indexPath) {
        return indexPath;
      }
    }

    // Otherwise there's nothing else we can do :(

    return null;
  }
}

/**
 * This function creates fake modules that can be used with the _resolveFilename function.
 * Ideally it would be nice to be able to avoid this, since it causes useless allocations
 * and cannot be cached efficiently (we recompute the nodeModulePaths every time).
 *
 * Fortunately, this should only affect the fallback, and there hopefully shouldn't be a
 * lot of them.
 */

function makeFakeModule(path) {
  const fakeModule = new Module(path, false);
  fakeModule.filename = path;
  fakeModule.paths = Module._nodeModulePaths(path);
  return fakeModule;
}

/**
 * Normalize path to posix format.
 */

function normalizePath(fsPath) {
  fsPath = path.normalize(fsPath);

  if (process.platform === 'win32') {
    fsPath = fsPath.replace(backwardSlashRegExp, '/');
  }

  return fsPath;
}

/**
 * Forward the resolution to the next resolver (usually the native one)
 */

function callNativeResolution(request, issuer) {
  if (issuer.endsWith('/')) {
    issuer += 'internal.js';
  }

  try {
    enableNativeHooks = false;

    // Since we would need to create a fake module anyway (to call _resolveLookupPath that
    // would give us the paths to give to _resolveFilename), we can as well not use
    // the {paths} option at all, since it internally makes _resolveFilename create another
    // fake module anyway.
    return Module._resolveFilename(request, makeFakeModule(issuer), false);
  } finally {
    enableNativeHooks = true;
  }
}

/**
 * This key indicates which version of the standard is implemented by this resolver. The `std` key is the
 * Plug'n'Play standard, and any other key are third-party extensions. Third-party extensions are not allowed
 * to override the standard, and can only offer new methods.
 *
 * If an new version of the Plug'n'Play standard is released and some extensions conflict with newly added
 * functions, they'll just have to fix the conflicts and bump their own version number.
 */

exports.VERSIONS = {std: 1};

/**
 * Useful when used together with getPackageInformation to fetch information about the top-level package.
 */

exports.topLevel = {name: null, reference: null};

/**
 * Gets the package information for a given locator. Returns null if they cannot be retrieved.
 */

exports.getPackageInformation = function getPackageInformation({name, reference}) {
  const packageInformationStore = packageInformationStores.get(name);

  if (!packageInformationStore) {
    return null;
  }

  const packageInformation = packageInformationStore.get(reference);

  if (!packageInformation) {
    return null;
  }

  return packageInformation;
};

/**
 * Transforms a request (what's typically passed as argument to the require function) into an unqualified path.
 * This path is called "unqualified" because it only changes the package name to the package location on the disk,
 * which means that the end result still cannot be directly accessed (for example, it doesn't try to resolve the
 * file extension, or to resolve directories to their "index.js" content). Use the "resolveUnqualified" function
 * to convert them to fully-qualified paths, or just use "resolveRequest" that do both operations in one go.
 *
 * Note that it is extremely important that the `issuer` path ends with a forward slash if the issuer is to be
 * treated as a folder (ie. "/tmp/foo/" rather than "/tmp/foo" if "foo" is a directory). Otherwise relative
 * imports won't be computed correctly (they'll get resolved relative to "/tmp/" instead of "/tmp/foo/").
 */

exports.resolveToUnqualified = function resolveToUnqualified(request, issuer, {considerBuiltins = true} = {}) {
  // The 'pnpapi' request is reserved and will always return the path to the PnP file, from everywhere

  if (request === `pnpapi`) {
    return pnpFile;
  }

  // Bailout if the request is a native module

  if (considerBuiltins && builtinModules.has(request)) {
    return null;
  }

  // We allow disabling the pnp resolution for some subpaths. This is because some projects, often legacy,
  // contain multiple levels of dependencies (ie. a yarn.lock inside a subfolder of a yarn.lock). This is
  // typically solved using workspaces, but not all of them have been converted already.

  if (ignorePattern && ignorePattern.test(normalizePath(issuer))) {
    const result = callNativeResolution(request, issuer);

    if (result === false) {
      throw makeError(
        `BUILTIN_NODE_RESOLUTION_FAIL`,
        `The builtin node resolution algorithm was unable to resolve the module referenced by "${request}" and requested from "${issuer}" (it didn't go through the pnp resolver because the issuer was explicitely ignored by the regexp "null")`,
        {
          request,
          issuer,
        }
      );
    }

    return result;
  }

  let unqualifiedPath;

  // If the request is a relative or absolute path, we just return it normalized

  const dependencyNameMatch = request.match(pathRegExp);

  if (!dependencyNameMatch) {
    if (path.isAbsolute(request)) {
      unqualifiedPath = path.normalize(request);
    } else if (issuer.match(isDirRegExp)) {
      unqualifiedPath = path.normalize(path.resolve(issuer, request));
    } else {
      unqualifiedPath = path.normalize(path.resolve(path.dirname(issuer), request));
    }
  }

  // Things are more hairy if it's a package require - we then need to figure out which package is needed, and in
  // particular the exact version for the given location on the dependency tree

  if (dependencyNameMatch) {
    const [, dependencyName, subPath] = dependencyNameMatch;

    const issuerLocator = exports.findPackageLocator(issuer);

    // If the issuer file doesn't seem to be owned by a package managed through pnp, then we resort to using the next
    // resolution algorithm in the chain, usually the native Node resolution one

    if (!issuerLocator) {
      const result = callNativeResolution(request, issuer);

      if (result === false) {
        throw makeError(
          `BUILTIN_NODE_RESOLUTION_FAIL`,
          `The builtin node resolution algorithm was unable to resolve the module referenced by "${request}" and requested from "${issuer}" (it didn't go through the pnp resolver because the issuer doesn't seem to be part of the Yarn-managed dependency tree)`,
          {
            request,
            issuer,
          }
        );
      }

      return result;
    }

    const issuerInformation = getPackageInformationSafe(issuerLocator);

    // We obtain the dependency reference in regard to the package that request it

    let dependencyReference = issuerInformation.packageDependencies.get(dependencyName);

    // If we can't find it, we check if we can potentially load it from the packages that have been defined as potential fallbacks.
    // It's a bit of a hack, but it improves compatibility with the existing Node ecosystem. Hopefully we should eventually be able
    // to kill this logic and become stricter once pnp gets enough traction and the affected packages fix themselves.

    if (issuerLocator !== topLevelLocator) {
      for (let t = 0, T = fallbackLocators.length; dependencyReference === undefined && t < T; ++t) {
        const fallbackInformation = getPackageInformationSafe(fallbackLocators[t]);
        dependencyReference = fallbackInformation.packageDependencies.get(dependencyName);
      }
    }

    // If we can't find the path, and if the package making the request is the top-level, we can offer nicer error messages

    if (!dependencyReference) {
      if (dependencyReference === null) {
        if (issuerLocator === topLevelLocator) {
          throw makeError(
            `MISSING_PEER_DEPENDENCY`,
            `You seem to be requiring a peer dependency ("${dependencyName}"), but it is not installed (which might be because you're the top-level package)`,
            {request, issuer, dependencyName}
          );
        } else {
          throw makeError(
            `MISSING_PEER_DEPENDENCY`,
            `Package "${issuerLocator.name}@${issuerLocator.reference}" is trying to access a peer dependency ("${dependencyName}") that should be provided by its direct ancestor but isn't`,
            {request, issuer, issuerLocator: Object.assign({}, issuerLocator), dependencyName}
          );
        }
      } else {
        if (issuerLocator === topLevelLocator) {
          throw makeError(
            `UNDECLARED_DEPENDENCY`,
            `You cannot require a package ("${dependencyName}") that is not declared in your dependencies (via "${issuer}")`,
            {request, issuer, dependencyName}
          );
        } else {
          const candidates = Array.from(issuerInformation.packageDependencies.keys());
          throw makeError(
            `UNDECLARED_DEPENDENCY`,
            `Package "${issuerLocator.name}@${issuerLocator.reference}" (via "${issuer}") is trying to require the package "${dependencyName}" (via "${request}") without it being listed in its dependencies (${candidates.join(
              `, `
            )})`,
            {request, issuer, issuerLocator: Object.assign({}, issuerLocator), dependencyName, candidates}
          );
        }
      }
    }

    // We need to check that the package exists on the filesystem, because it might not have been installed

    const dependencyLocator = {name: dependencyName, reference: dependencyReference};
    const dependencyInformation = exports.getPackageInformation(dependencyLocator);
    const dependencyLocation = path.resolve(__dirname, dependencyInformation.packageLocation);

    if (!dependencyLocation) {
      throw makeError(
        `MISSING_DEPENDENCY`,
        `Package "${dependencyLocator.name}@${dependencyLocator.reference}" is a valid dependency, but hasn't been installed and thus cannot be required (it might be caused if you install a partial tree, such as on production environments)`,
        {request, issuer, dependencyLocator: Object.assign({}, dependencyLocator)}
      );
    }

    // Now that we know which package we should resolve to, we only have to find out the file location

    if (subPath) {
      unqualifiedPath = path.resolve(dependencyLocation, subPath);
    } else {
      unqualifiedPath = dependencyLocation;
    }
  }

  return path.normalize(unqualifiedPath);
};

/**
 * Transforms an unqualified path into a qualified path by using the Node resolution algorithm (which automatically
 * appends ".js" / ".json", and transforms directory accesses into "index.js").
 */

exports.resolveUnqualified = function resolveUnqualified(
  unqualifiedPath,
  {extensions = Object.keys(Module._extensions)} = {}
) {
  const qualifiedPath = applyNodeExtensionResolution(unqualifiedPath, {extensions});

  if (qualifiedPath) {
    return path.normalize(qualifiedPath);
  } else {
    throw makeError(
      `QUALIFIED_PATH_RESOLUTION_FAILED`,
      `Couldn't find a suitable Node resolution for unqualified path "${unqualifiedPath}"`,
      {unqualifiedPath}
    );
  }
};

/**
 * Transforms a request into a fully qualified path.
 *
 * Note that it is extremely important that the `issuer` path ends with a forward slash if the issuer is to be
 * treated as a folder (ie. "/tmp/foo/" rather than "/tmp/foo" if "foo" is a directory). Otherwise relative
 * imports won't be computed correctly (they'll get resolved relative to "/tmp/" instead of "/tmp/foo/").
 */

exports.resolveRequest = function resolveRequest(request, issuer, {considerBuiltins, extensions} = {}) {
  let unqualifiedPath;

  try {
    unqualifiedPath = exports.resolveToUnqualified(request, issuer, {considerBuiltins});
  } catch (originalError) {
    // If we get a BUILTIN_NODE_RESOLUTION_FAIL error there, it means that we've had to use the builtin node
    // resolution, which usually shouldn't happen. It might be because the user is trying to require something
    // from a path loaded through a symlink (which is not possible, because we need something normalized to
    // figure out which package is making the require call), so we try to make the same request using a fully
    // resolved issuer and throws a better and more actionable error if it works.
    if (originalError.code === `BUILTIN_NODE_RESOLUTION_FAIL`) {
      let realIssuer;

      try {
        realIssuer = realpathSync(issuer);
      } catch (error) {}

      if (realIssuer) {
        if (issuer.endsWith(`/`)) {
          realIssuer = realIssuer.replace(/\/?$/, `/`);
        }

        try {
          exports.resolveToUnqualified(request, realIssuer, {considerBuiltins});
        } catch (error) {
          // If an error was thrown, the problem doesn't seem to come from a path not being normalized, so we
          // can just throw the original error which was legit.
          throw originalError;
        }

        // If we reach this stage, it means that resolveToUnqualified didn't fail when using the fully resolved
        // file path, which is very likely caused by a module being invoked through Node with a path not being
        // correctly normalized (ie you should use "node $(realpath script.js)" instead of "node script.js").
        throw makeError(
          `SYMLINKED_PATH_DETECTED`,
          `A pnp module ("${request}") has been required from what seems to be a symlinked path ("${issuer}"). This is not possible, you must ensure that your modules are invoked through their fully resolved path on the filesystem (in this case "${realIssuer}").`,
          {
            request,
            issuer,
            realIssuer,
          }
        );
      }
    }
    throw originalError;
  }

  if (unqualifiedPath === null) {
    return null;
  }

  try {
    return exports.resolveUnqualified(unqualifiedPath, {extensions});
  } catch (resolutionError) {
    if (resolutionError.code === 'QUALIFIED_PATH_RESOLUTION_FAILED') {
      Object.assign(resolutionError.data, {request, issuer});
    }
    throw resolutionError;
  }
};

/**
 * Setups the hook into the Node environment.
 *
 * From this point on, any call to `require()` will go through the "resolveRequest" function, and the result will
 * be used as path of the file to load.
 */

exports.setup = function setup() {
  // A small note: we don't replace the cache here (and instead use the native one). This is an effort to not
  // break code similar to "delete require.cache[require.resolve(FOO)]", where FOO is a package located outside
  // of the Yarn dependency tree. In this case, we defer the load to the native loader. If we were to replace the
  // cache by our own, the native loader would populate its own cache, which wouldn't be exposed anymore, so the
  // delete call would be broken.

  const originalModuleLoad = Module._load;

  Module._load = function(request, parent, isMain) {
    if (!enableNativeHooks) {
      return originalModuleLoad.call(Module, request, parent, isMain);
    }

    // Builtins are managed by the regular Node loader

    if (builtinModules.has(request)) {
      try {
        enableNativeHooks = false;
        return originalModuleLoad.call(Module, request, parent, isMain);
      } finally {
        enableNativeHooks = true;
      }
    }

    // The 'pnpapi' name is reserved to return the PnP api currently in use by the program

    if (request === `pnpapi`) {
      return pnpModule.exports;
    }

    // Request `Module._resolveFilename` (ie. `resolveRequest`) to tell us which file we should load

    const modulePath = Module._resolveFilename(request, parent, isMain);

    // Check if the module has already been created for the given file

    const cacheEntry = Module._cache[modulePath];

    if (cacheEntry) {
      return cacheEntry.exports;
    }

    // Create a new module and store it into the cache

    const module = new Module(modulePath, parent);
    Module._cache[modulePath] = module;

    // The main module is exposed as global variable

    if (isMain) {
      process.mainModule = module;
      module.id = '.';
    }

    // Try to load the module, and remove it from the cache if it fails

    let hasThrown = true;

    try {
      module.load(modulePath);
      hasThrown = false;
    } finally {
      if (hasThrown) {
        delete Module._cache[modulePath];
      }
    }

    // Some modules might have to be patched for compatibility purposes

    for (const [filter, patchFn] of patchedModules) {
      if (filter.test(request)) {
        module.exports = patchFn(exports.findPackageLocator(parent.filename), module.exports);
      }
    }

    return module.exports;
  };

  const originalModuleResolveFilename = Module._resolveFilename;

  Module._resolveFilename = function(request, parent, isMain, options) {
    if (!enableNativeHooks) {
      return originalModuleResolveFilename.call(Module, request, parent, isMain, options);
    }

    let issuers;

    if (options) {
      const optionNames = new Set(Object.keys(options));
      optionNames.delete('paths');

      if (optionNames.size > 0) {
        throw makeError(
          `UNSUPPORTED`,
          `Some options passed to require() aren't supported by PnP yet (${Array.from(optionNames).join(', ')})`
        );
      }

      if (options.paths) {
        issuers = options.paths.map(entry => `${path.normalize(entry)}/`);
      }
    }

    if (!issuers) {
      const issuerModule = getIssuerModule(parent);
      const issuer = issuerModule ? issuerModule.filename : `${process.cwd()}/`;

      issuers = [issuer];
    }

    let firstError;

    for (const issuer of issuers) {
      let resolution;

      try {
        resolution = exports.resolveRequest(request, issuer);
      } catch (error) {
        firstError = firstError || error;
        continue;
      }

      return resolution !== null ? resolution : request;
    }

    throw firstError;
  };

  const originalFindPath = Module._findPath;

  Module._findPath = function(request, paths, isMain) {
    if (!enableNativeHooks) {
      return originalFindPath.call(Module, request, paths, isMain);
    }

    for (const path of paths || []) {
      let resolution;

      try {
        resolution = exports.resolveRequest(request, path);
      } catch (error) {
        continue;
      }

      if (resolution) {
        return resolution;
      }
    }

    return false;
  };

  process.versions.pnp = String(exports.VERSIONS.std);
};

exports.setupCompatibilityLayer = () => {
  // ESLint currently doesn't have any portable way for shared configs to specify their own
  // plugins that should be used (https://github.com/eslint/eslint/issues/10125). This will
  // likely get fixed at some point, but it'll take time and in the meantime we'll just add
  // additional fallback entries for common shared configs.

  for (const name of [`react-scripts`]) {
    const packageInformationStore = packageInformationStores.get(name);
    if (packageInformationStore) {
      for (const reference of packageInformationStore.keys()) {
        fallbackLocators.push({name, reference});
      }
    }
  }

  // Modern versions of `resolve` support a specific entry point that custom resolvers can use
  // to inject a specific resolution logic without having to patch the whole package.
  //
  // Cf: https://github.com/browserify/resolve/pull/174

  patchedModules.push([
    /^\.\/normalize-options\.js$/,
    (issuer, normalizeOptions) => {
      if (!issuer || issuer.name !== 'resolve') {
        return normalizeOptions;
      }

      return (request, opts) => {
        opts = opts || {};

        if (opts.forceNodeResolution) {
          return opts;
        }

        opts.preserveSymlinks = true;
        opts.paths = function(request, basedir, getNodeModulesDir, opts) {
          // Extract the name of the package being requested (1=full name, 2=scope name, 3=local name)
          const parts = request.match(/^((?:(@[^\/]+)\/)?([^\/]+))/);

          // make sure that basedir ends with a slash
          if (basedir.charAt(basedir.length - 1) !== '/') {
            basedir = path.join(basedir, '/');
          }
          // This is guaranteed to return the path to the "package.json" file from the given package
          const manifestPath = exports.resolveToUnqualified(`${parts[1]}/package.json`, basedir);

          // The first dirname strips the package.json, the second strips the local named folder
          let nodeModules = path.dirname(path.dirname(manifestPath));

          // Strips the scope named folder if needed
          if (parts[2]) {
            nodeModules = path.dirname(nodeModules);
          }

          return [nodeModules];
        };

        return opts;
      };
    },
  ]);
};

if (module.parent && module.parent.id === 'internal/preload') {
  exports.setupCompatibilityLayer();

  exports.setup();
}

if (process.mainModule === module) {
  exports.setupCompatibilityLayer();

  const reportError = (code, message, data) => {
    process.stdout.write(`${JSON.stringify([{code, message, data}, null])}\n`);
  };

  const reportSuccess = resolution => {
    process.stdout.write(`${JSON.stringify([null, resolution])}\n`);
  };

  const processResolution = (request, issuer) => {
    try {
      reportSuccess(exports.resolveRequest(request, issuer));
    } catch (error) {
      reportError(error.code, error.message, error.data);
    }
  };

  const processRequest = data => {
    try {
      const [request, issuer] = JSON.parse(data);
      processResolution(request, issuer);
    } catch (error) {
      reportError(`INVALID_JSON`, error.message, error.data);
    }
  };

  if (process.argv.length > 2) {
    if (process.argv.length !== 4) {
      process.stderr.write(`Usage: ${process.argv[0]} ${process.argv[1]} <request> <issuer>\n`);
      process.exitCode = 64; /* EX_USAGE */
    } else {
      processResolution(process.argv[2], process.argv[3]);
    }
  } else {
    let buffer = '';
    const decoder = new StringDecoder.StringDecoder();

    process.stdin.on('data', chunk => {
      buffer += decoder.write(chunk);

      do {
        const index = buffer.indexOf('\n');
        if (index === -1) {
          break;
        }

        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);

        processRequest(line);
      } while (true);
    });
  }
}
