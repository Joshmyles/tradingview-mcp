// Minimal lint guard.
//
// Primary purpose: catch `no-undef` ("X is not defined") — the exact class of bug
// that an unfinished refactor introduces silently. When imports are renamed
// (e.g. `evaluate` -> `_evaluate` behind a `_resolve(_deps)` helper) but a few
// call sites are missed, the code parses fine and only throws at runtime.
// `no-undef` flags those statically, so CI blocks the regression at PR time.
//
// Globals below are the runtime APIs used across src/ (Node + browser/CDP context).

// The verdict keys `ok` and `success` may be written ONLY by src/internals/verdict.js.
// Any other object literal or assignment under src/ that sets them is an error.
// Why a rule rather than review: the same overwrite defect was written twice in
// one day by someone who had just fixed it (see the header of verdict.js).
// Page-context JS lives in strings, which this AST rule does not see — those
// objects are page data, and become results only once wrapped by verdict.js.
// tests/verdict-only-path.test.js runs this rule inside `npm test`.
const VERDICT_MESSAGE =
  'Result verdict keys (ok / success) are written only by src/internals/verdict.js. '
  + 'Use observed / refused / unobservable / answered / failed, or withDetail() to add fields.';
export const VERDICT_ONLY_PATH = {
  files: ['src/**/*.js'],
  ignores: ['src/internals/verdict.js'],
  rules: {
    'no-restricted-syntax': ['error',
      { selector: 'ObjectExpression > Property[computed=false][key.name=/^(ok|success)$/]', message: VERDICT_MESSAGE },
      { selector: 'ObjectExpression > Property[computed=false][key.value=/^(ok|success)$/]', message: VERDICT_MESSAGE },
      { selector: 'ObjectExpression > Property[computed=true][key.value=/^(ok|success)$/]', message: VERDICT_MESSAGE },
      { selector: 'AssignmentExpression > MemberExpression.left[property.name=/^(ok|success)$/]', message: VERDICT_MESSAGE },
      { selector: 'AssignmentExpression > MemberExpression.left[property.value=/^(ok|success)$/]', message: VERDICT_MESSAGE },
    ],
  },
};

export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly',
        process: 'readonly', Buffer: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', WebSocket: 'readonly', AbortController: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', global: 'readonly',
        __dirname: 'readonly', structuredClone: 'readonly',
        queueMicrotask: 'readonly', performance: 'readonly',
        // Page context: these appear inside CDP-evaluated expression strings
        // and in the test doubles that stand in for them.
        window: 'readonly', document: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  VERDICT_ONLY_PATH,
];
