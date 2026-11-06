/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'ide-bg': 'var(--ide-bg)',
        'ide-fg': 'var(--ide-fg)',
        'ide-panel-bg': 'var(--ide-panel-bg)',
        'ide-panel-border': 'var(--ide-panel-border)',
        'ide-selection': 'var(--ide-selection)',
        'ide-selection-inactive': 'var(--ide-selection-inactive)',
        'ide-tab-bg': 'var(--ide-tab-bg)',
        'ide-tab-active-bg': 'var(--ide-tab-active-bg)',
        'ide-tab-hover': 'var(--ide-tab-hover)',
        'ide-accent': 'var(--ide-accent)',
        'ide-tree-hover': 'var(--ide-tree-hover)',
      }
    },
  },
  plugins: [],
}