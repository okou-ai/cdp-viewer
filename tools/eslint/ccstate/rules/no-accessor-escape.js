// Adapted from okou-ai/okou@7354b16deac91ae677fa1edbfb82d16c5c6e5504.
/**
 * ESLint rule: no-accessor-escape
 *
 * ccstate get/set accessors are scoped capabilities. They must only be called
 * directly inside command()/computed() callbacks, never passed to helpers,
 * stored in objects, aliased, returned, or captured as values.
 */
import { AST_NODE_TYPES } from "@typescript-eslint/utils";
import { createRule } from "../utils.js";
const DEFERRED_CALLBACK_FUNCTIONS = new Set(["setInterval", "setTimeout"]);
function isCallbackNode(node) {
  return (
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionExpression
  );
}
function isFunctionNode(node) {
  return (
    isCallbackNode(node) || node.type === AST_NODE_TYPES.FunctionDeclaration
  );
}
function isDirectCallCallee(node) {
  const parent = node.parent;
  return (
    parent.type === AST_NODE_TYPES.CallExpression && parent.callee === node
  );
}
function isDeferredCallbackCall(call, callback) {
  if (!call.arguments.includes(callback)) {
    return false;
  }
  if (
    call.callee.type === AST_NODE_TYPES.Identifier &&
    DEFERRED_CALLBACK_FUNCTIONS.has(call.callee.name)
  ) {
    return true;
  }
  return false;
}
function isReturnedContainerCallback(node) {
  let current = node.parent;
  while (
    current?.type === AST_NODE_TYPES.Property ||
    current?.type === AST_NODE_TYPES.ObjectExpression ||
    current?.type === AST_NODE_TYPES.ArrayExpression
  ) {
    current = current.parent;
  }
  return current?.type === AST_NODE_TYPES.ReturnStatement;
}
function callbackEscapes(primitive, node) {
  if (primitive !== "command") {
    return false;
  }
  if (!isCallbackNode(node)) {
    return false;
  }
  const parent = node.parent;
  if (parent.type === AST_NODE_TYPES.ReturnStatement) {
    return true;
  }
  if (parent.type === AST_NODE_TYPES.CallExpression) {
    return isDeferredCallbackCall(parent, node);
  }
  return isReturnedContainerCallback(node);
}
function isAllowedAccessorUse(primitive, identifier, callback) {
  if (!isDirectCallCallee(identifier)) {
    return false;
  }
  let current = identifier.parent;
  while (current && current !== callback) {
    if (isFunctionNode(current) && callbackEscapes(primitive, current)) {
      return false;
    }
    current = current.parent;
  }
  return current === callback;
}
function bindingFromPropertyValue(value) {
  if (value.type === AST_NODE_TYPES.Identifier) {
    return value;
  }
  if (
    value.type === AST_NODE_TYPES.AssignmentPattern &&
    value.left.type === AST_NODE_TYPES.Identifier
  ) {
    return value.left;
  }
  return null;
}
function commandAccessorBindings(callback) {
  const firstParam = callback.params[0];
  if (!firstParam || firstParam.type !== AST_NODE_TYPES.ObjectPattern) {
    return [];
  }
  const bindings = [];
  for (const property of firstParam.properties) {
    if (
      property.type !== AST_NODE_TYPES.Property ||
      property.key.type !== AST_NODE_TYPES.Identifier ||
      (property.key.name !== "get" && property.key.name !== "set")
    ) {
      continue;
    }
    const binding = bindingFromPropertyValue(property.value);
    if (binding) {
      bindings.push(binding);
    }
  }
  return bindings;
}
function computedAccessorBindings(callback) {
  const firstParam = callback.params[0];
  return firstParam?.type === AST_NODE_TYPES.Identifier ? [firstParam] : [];
}
export default createRule({
  name: "no-accessor-escape",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent ccstate get/set accessors from escaping command()/computed() callbacks",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      accessorEscape:
        "ccstate accessor '{{name}}' must only be called directly; do not pass, store, return, alias, or wrap it.",
    },
  },
  create(context) {
    function checkCallback(primitive, callback) {
      const bindings =
        primitive === "command"
          ? commandAccessorBindings(callback)
          : computedAccessorBindings(callback);
      if (bindings.length === 0) {
        return;
      }
      const bindingNames = new Set(
        bindings.map((binding) => {
          return binding.name;
        }),
      );
      const variables = context.sourceCode.getDeclaredVariables(callback);
      for (const variable of variables) {
        if (!bindingNames.has(variable.name)) {
          continue;
        }
        for (const reference of variable.references) {
          const identifier = reference.identifier;
          if (identifier.type !== AST_NODE_TYPES.Identifier) {
            continue;
          }
          if (isAllowedAccessorUse(primitive, identifier, callback)) {
            continue;
          }
          context.report({
            node: identifier,
            messageId: "accessorEscape",
            data: { name: identifier.name },
          });
        }
      }
    }
    return {
      CallExpression(node) {
        if (
          node.callee.type !== AST_NODE_TYPES.Identifier ||
          (node.callee.name !== "command" && node.callee.name !== "computed")
        ) {
          return;
        }
        const callback = node.arguments[0];
        if (!callback || !isCallbackNode(callback)) {
          return;
        }
        checkCallback(node.callee.name, callback);
      },
    };
  },
});
