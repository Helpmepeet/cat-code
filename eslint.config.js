import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

function createNoopRule() {
  return {
    meta: {
      type: 'suggestion',
      schema: [],
      docs: {
        description: 'Local no-op compatibility rule stub',
      },
    },
    create() {
      return {};
    },
  };
}

function createRuleMap(ruleNames) {
  return Object.fromEntries(ruleNames.map((name) => [name, createNoopRule()]));
}

const customRulesPlugin = {
  rules: createRuleMap([
    'bootstrap-isolation',
    'no-cross-platform-process-issues',
    'no-direct-json-operations',
    'no-direct-ps-commands',
    'no-lookbehind-regex',
    'no-process-cwd',
    'no-process-env-top-level',
    'no-process-exit',
    'no-sync-fs',
    'no-top-level-dynamic-import',
    'no-top-level-side-effects',
    'prefer-use-keybindings',
    'prefer-use-terminal-size',
    'prompt-spacing',
    'require-bun-typeof-guard',
    'require-tool-match-name',
    'safe-env-boolean-check',
  ]),
};

const nodeCompatibilityPlugin = {
  rules: createRuleMap([
    'no-sync',
    'no-unsupported-features/node-builtins',
  ]),
};

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'custom-rules': customRulesPlugin,
      'eslint-plugin-n': nodeCompatibilityPlugin,
    },
    rules: {
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': 'off',
    },
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
];
