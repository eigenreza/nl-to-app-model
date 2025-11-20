import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          root: './packages/server',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      // The browser package brings its own config so that the React plugin and
      // the workspace alias are shared with the dev server rather than copied.
      './packages/web',
    ],
  },
});
