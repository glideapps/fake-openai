/// <reference types="vite/client" />

// Raw-string imports (e.g. `import readme from "../../README.md?raw"`). Lets the
// UI render the on-disk README directly, so redeploying updates the docs.
declare module "*?raw" {
  const content: string;
  export default content;
}
