import globals from "globals";

const rules = {
    "no-const-assign": "warn",
    "no-this-before-super": "warn",
    "no-undef": "warn",
    "no-unreachable": "warn",
    "no-unused-vars": "warn",
    "constructor-super": "warn",
    "valid-typeof": "warn",
};

export default [{
    // Extension host (Node)
    files: ["**/*.js"],
    languageOptions: {
        globals: { ...globals.node },
        ecmaVersion: 2022,
        sourceType: "module",
    },
    rules,
}, {
    // Webview (browser)
    files: ["src/editor.js", "src/editor/**/*.js"],
    languageOptions: {
        globals: { ...globals.browser, acquireVsCodeApi: "readonly" },
        ecmaVersion: 2022,
        sourceType: "module",
    },
    rules,
}];
