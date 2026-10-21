// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-side-effect-in-render. See docs/state-architecture.md. */
import { createRule } from "../utils.js";
const DEFAULT_FORBIDDEN_CALLS = ["detach", "queueMicrotask"];
function isComponentOrHookFunction(node) {
  // PascalCase function declaration: function MyView() {}
  if (node.type === "FunctionDeclaration" && node.id) {
    return /^[A-Z]/.test(node.id.name);
  }
  // Arrow function or function expression assigned to PascalCase variable:
  // const MyView = () => {} or const MyView = function() {}
  const parent = node.parent;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "Identifier"
  ) {
    return /^[A-Z]/.test(parent.id.name);
  }
  // export default function() {} — treat as component if in a .tsx file
  if (
    node.type === "FunctionDeclaration" &&
    node.parent?.type === "ExportDefaultDeclaration"
  ) {
    const filename = getCurrentFilename(node);
    return filename.endsWith(".tsx");
  }
  return false;
}
function getCurrentFilename(node) {
  let current = node;
  while (current.parent) {
    current = current.parent;
  }
  // The root node doesn't have filename, we rely on context instead
  return "";
}
export default createRule({
  name: "no-side-effect-in-render",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calling side-effect functions directly in React component render body",
    },
    schema: [
      {
        type: "object",
        properties: {
          forbiddenCalls: {
            type: "array",
            items: { type: "string" },
            description: "Additional function names to forbid during render",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noSetInRender:
        "Do not dispatch commands during render. Move the call into an event handler.",
      noSideEffectInRender:
        "Do not call '{{ name }}()' directly during render. Side effects should be in event handlers or effect callbacks.",
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const forbiddenCalls = new Set(
      options.forbiddenCalls ?? DEFAULT_FORBIDDEN_CALLS,
    );
    // Track function nesting: [isComponent, isComponent, ...]
    // When we enter a component function, push true. For nested functions, push false.
    // A call is "in render" when the innermost function scope is a component (stack top === true).
    const scopeStack = [];
    // Track variable names that hold useSet() return values, per component scope
    const setterNamesStack = [];
    function enterFunction(node) {
      const isComponent = isComponentOrHookFunction(node);
      scopeStack.push(isComponent);
      if (isComponent) {
        setterNamesStack.push(new Set());
      }
    }
    function exitFunction() {
      const wasComponent = scopeStack.pop();
      if (wasComponent) {
        setterNamesStack.pop();
      }
    }
    function isInRenderScope() {
      // The call is directly in render if the innermost scope is a component scope
      return (
        scopeStack.length > 0 && scopeStack[scopeStack.length - 1] === true
      );
    }
    function getCurrentSetterNames() {
      return setterNamesStack.length > 0
        ? setterNamesStack[setterNamesStack.length - 1]
        : undefined;
    }
    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      // Track: const set = useSet()
      VariableDeclarator(node) {
        if (!isInRenderScope()) {
          return;
        }
        const init = node.init;
        if (
          init?.type === "CallExpression" &&
          init.callee.type === "Identifier" &&
          init.callee.name === "useSet" &&
          node.id.type === "Identifier"
        ) {
          getCurrentSetterNames()?.add(node.id.name);
        }
      },
      // Check for forbidden calls
      CallExpression(node) {
        if (!isInRenderScope()) {
          return;
        }
        const callee = node.callee;
        if (
          callee.type === "CallExpression" &&
          callee.callee.type === "Identifier" &&
          callee.callee.name === "useSet"
        ) {
          context.report({
            node,
            messageId: "noSetInRender",
          });
          return;
        }
        if (callee.type !== "Identifier") {
          return;
        }
        // Check for set() from useSet()
        const setterNames = getCurrentSetterNames();
        if (setterNames?.has(callee.name)) {
          context.report({
            node,
            messageId: "noSetInRender",
          });
          return;
        }
        // Check for forbidden function calls (detach, etc.)
        if (forbiddenCalls.has(callee.name)) {
          context.report({
            node,
            messageId: "noSideEffectInRender",
            data: { name: callee.name },
          });
        }
      },
    };
  },
});
