// Obsidian's plugin guidelines, the same rules its automated review uses.
// Biome (npm run lint) stays the main linter and formatter; this checks
// only what Obsidian's review cares about: npm run lint:obsidian.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_ACRONYMS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';

export default defineConfig([
  { ignores: ['main.js', 'node_modules/', 'demo/', 'test/', 'eslint.config.mjs'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.js', 'src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The recommended config turns these on only for .ts files, but Obsidian's
      // review also runs them on .js, and an error there fails the release.
      'obsidianmd/no-unsupported-api': 'error',
      'obsidianmd/no-plugin-as-component': 'error',
      'obsidianmd/no-view-references-in-plugin': 'error',
      // Also from the review: values typed `any` (untyped parameters, JSON).
      // JSDoc types and src/types.d.ts keep these at zero.
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      // Proper names the default lists don't know. Obsidian's own review uses
      // the defaults, so it may still show these as warnings.
      'obsidianmd/ui/sentence-case': [
        'warn',
        {
          brands: [
            ...DEFAULT_BRANDS,
            'Cal Track',
            'FoodData Central',
            'Open Food Facts',
            'Periodic Notes',
          ],
          acronyms: [...DEFAULT_ACRONYMS, 'USDA', 'US'],
        },
      ],
    },
  },
]);
