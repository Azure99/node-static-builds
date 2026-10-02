import js from "@eslint/js";
import globals from "globals";

export default [
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node },
    rules: { ...js.configs.recommended.rules, curly: ["error", "all"] },
  },
];
