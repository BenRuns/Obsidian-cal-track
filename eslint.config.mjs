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
    files: ['src/**/*.js'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
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
