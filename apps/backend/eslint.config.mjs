// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // The WhatsApp routing path must not be able to reach a language model.
    //
    // command-router.service.ts has claimed "by design and by an ESLint
    // boundary" since it was written, and no such rule existed — so the claim
    // was true only by accident of what nobody had imported yet.
    //
    // It matters because these files decide WHICH ACTION RUNS, and some of
    // those actions write. A model that can pick an action is a model that can
    // pick the wrong one, and "in"/"out" and "approve"/"reject" are each one
    // token apart in meaning. Anything AI-shaped hands off through
    // WHATSAPP_AI_PORT, which is reachable only from the no-match branch.
    files: [
      'src/whatsapp/router/**/*.ts',
      'src/whatsapp/inbound/**/*.ts',
      'src/whatsapp/session/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/copilot/**',
                '**/chatbot/**',
                'openai',
                '@openrouter/*',
                '@anthropic-ai/*',
                '@google/generative-ai',
              ],
              message:
                'The WhatsApp router must not reach a language model. Hand off through WHATSAPP_AI_PORT instead.',
            },
          ],
        },
      ],
    },
  },
);
