// Allow `import './Foo.css'` side-effect imports under the TS bundler
// resolution without type errors. Vite handles the actual bundling.
declare module '*.css';
