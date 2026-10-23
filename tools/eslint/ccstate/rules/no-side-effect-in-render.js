// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/** Library policy: no-side-effect-in-render. See docs/state-architecture.md. */
import { createRule } from "../utils.js";
const DEFAULT_FORBIDDEN_CALLS = ["detach", "queueMicrotask"];
function isComponentOrHookFunction(node, filename) {
  if (
    node.parent?.type === "MethodDefinition" &&
    node.parent.key.name === "render"
  )
    return true;
  // Default exports in TSX are components, including anonymous arrows and
  // functions whose local name does not follow the component convention.
  if (
    node.parent?.type === "ExportDefaultDeclaration" &&
    filename.endsWith(".tsx")
  ) {
    return true;
  }
  const renderName = /^(?:[A-Z]|use[A-Z])/;
  if (node.type === "FunctionDeclaration" && node.id) {
    return renderName.test(node.id.name);
  }
  // Arrow/function expressions assigned to component or custom-hook names.
  const parent = node.parent;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "Identifier"
  ) {
    return renderName.test(parent.id.name);
  }
  return false;
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
    // Deferred callbacks start a separate scope; an IIFE executes in the
    // enclosing scope and must retain its render/handler classification.
    const scopeStack = [];
    // Track variable names that hold useSet() return values, per component scope
    const setterNamesStack = [];
    function enterFunction(node) {
      const immediate =
        node.parent?.type === "CallExpression" && node.parent.callee === node;
      const inRender = immediate
        ? isInRenderScope()
        : isComponentOrHookFunction(node, context.filename);
      scopeStack.push(inRender);
      if (inRender) {
        setterNamesStack.push(
          immediate ? new Set(getCurrentSetterNames()) : new Set(),
        );
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
