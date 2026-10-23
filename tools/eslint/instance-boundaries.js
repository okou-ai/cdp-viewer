import { ASTUtils } from "@typescript-eslint/utils";
import { inView, owningFactory } from "./ownership.js";
const factoryName = /^create(?:.*(?:Model|Signals)|Instance|Store)$/;

function canonicalName(context, node, depth = 0) {
  if (!node || depth > 6) return null;
  if (node.type === "Identifier") {
    const variable = ASTUtils.findVariable(
      context.sourceCode.getScope(node),
      node,
    );
    const definition = variable?.defs[0];
    if (
      definition?.type === "ImportBinding" &&
      definition.node.type === "ImportSpecifier"
    ) {
      return definition.node.imported.name ?? definition.node.imported.value;
    }
    if (
      definition?.type === "Variable" &&
      ["Identifier", "MemberExpression"].includes(definition.node.init?.type)
    ) {
      return canonicalName(context, definition.node.init, depth + 1);
    }
    return node.name;
  }
  if (node.type === "MemberExpression") {
    if (node.object.type !== "Identifier") return null;
    const variable = ASTUtils.findVariable(
      context.sourceCode.getScope(node),
      node.object,
    );
    if (variable?.defs[0]?.node.type !== "ImportNamespaceSpecifier")
      return null;
    return node.computed ? (node.property.value ?? null) : node.property.name;
  }
  return null;
}

function isOwned(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      [
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ].includes(parent.type)
    ) {
      if (
        ["MethodDefinition", "PropertyDefinition"].includes(
          parent.parent.type,
        ) &&
        parent.parent.static
      )
        return false;
      if (
        parent.parent.type === "CallExpression" &&
        parent.parent.callee === parent
      )
        continue;
      return true;
    }
    if (parent.type === "PropertyDefinition" && !parent.static) return true;
  }
  return false;
}

function inCommand(context, node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      parent.type === "CallExpression" &&
      canonicalName(context, parent.callee) === "command"
    )
      return true;
  }
  return false;
}

export const instanceBoundaries = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      global:
        "Create each {{name}} in its instance owner, never at module/static scope.",
      factory:
        "Only a model factory may allocate an instance; views use their private scope.",
      context:
        "Declare immutable private context metadata outside render and commands.",
      command:
        "Construct signal graphs before commands run; command execution must not create another graph.",
      model:
        "Pass the model factory to its private scope; ordinary code must not construct another model instance.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = canonicalName(context, node.callee);
        if (
          name === "createScope" &&
          (isOwned(node) || inCommand(context, node))
        )
          context.report({ node, messageId: "context" });
        if (
          name === "createContext" &&
          (inView(node) || inCommand(context, node))
        )
          context.report({ node, messageId: "context" });
        if (
          name === "createInstance" &&
          !/^create.*Model$/.test(owningFactory(node))
        )
          context.report({ node, messageId: "factory" });
        if (/^create.*Model$/.test(name ?? ""))
          context.report({ node, messageId: "model" });
        if (!name || !factoryName.test(name)) return;
        if (!isOwned(node))
          context.report({ node, messageId: "global", data: { name } });
        if (inCommand(context, node))
          context.report({ node, messageId: "command" });
      },
      NewExpression(node) {
        const name = canonicalName(context, node.callee);
        if (
          [
            "WebSocket",
            "ViewerController",
            "CdpClient",
            "NativeInput",
            "CanvasRenderer",
            "AbortController",
          ].includes(name) &&
          !isOwned(node)
        )
          context.report({ node, messageId: "global", data: { name } });
      },
    };
  },
};

export const viewWrites = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      write:
        "Views read projections and invoke bound commands; move mutable state/transport orchestration to its owner.",
    },
  },
  create(context) {
    const methods = new Set([
      "set",
      "run",
      "read",
      "watch",
      "update",
      "getSnapshot",
      "subscribe",
      "select",
      "navigate",
      "setPaused",
      "start",
      "close",
      "dispose",
    ]);
    function boundCommand(node, depth = 0) {
      if (node?.type !== "Identifier" || depth > 6) return false;
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(node),
        node,
      );
      const init = variable?.defs[0]?.node.init;
      if (init?.type === "Identifier") return boundCommand(init, depth + 1);
      if (init?.type !== "CallExpression") return false;
      const name =
        init.callee.type === "MemberExpression"
          ? init.callee.property.name
          : init.callee.name;
      return ["useCommand", "useSet"].includes(name);
    }
    function duringRender(node) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (
          ![
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
          ].includes(parent.type)
        )
          continue;
        if (
          parent.parent.type === "CallExpression" &&
          parent.parent.callee === parent
        )
          continue;
        if (parent.parent.type === "ExportDefaultDeclaration") return true;
        if (parent.parent.type === "MethodDefinition")
          return parent.parent.key.name === "render";
        const name =
          parent.id?.name ??
          (parent.parent.type === "VariableDeclarator"
            ? parent.parent.id.name
            : "");
        return /^(?:[A-Z]|use[A-Z])/.test(name ?? "");
      }
      return false;
    }
    return {
      PropertyDefinition(node) {
        if (
          node.key.name === "state" &&
          canonicalName(context, node.parent.parent.superClass) === "Component"
        )
          context.report({ node, messageId: "write" });
      },
      CallExpression(node) {
        if (boundCommand(node.callee) && duringRender(node))
          context.report({ node, messageId: "write" });
        if (node.callee.type === "MemberExpression") {
          const name = node.callee.computed
            ? node.callee.property.value
            : node.callee.property.name;
          if (methods.has(name) && inView(node))
            context.report({ node, messageId: "write" });
        }
      },
      AssignmentExpression(node) {
        if (node.left.type === "MemberExpression" && inView(node))
          context.report({ node, messageId: "write" });
      },
      UpdateExpression(node) {
        if (node.argument.type === "MemberExpression" && inView(node))
          context.report({ node, messageId: "write" });
      },
    };
  },
};

export const signalImports = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      canonical:
        "Import ccstate primitives by their canonical names; aliases/namespaces bypass syntax-based ownership checks.",
      owner:
        "Construct state/computed/commands inside an instance signal/model factory.",
      subpath:
        "Use the ccstate root entry; runtime subpaths bypass the construction/ownership checks.",
      forwarding:
        "Do not forward React/ccstate primitives through another module; use the private instance interface.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          ["state", "computed", "command"].includes(
            canonicalName(context, node.callee),
          ) &&
          !/^create.*(?:Model|Signals)$/.test(owningFactory(node))
        )
          context.report({ node, messageId: "owner" });
      },
      ExportNamedDeclaration(node) {
        if (
          node.exportKind === "type" ||
          !node.source ||
          node.specifiers.every((item) => item.exportKind === "type")
        )
          return;
        if (/^(?:react|ccstate|ccstate-react)(?:\/|$)/.test(node.source.value))
          context.report({ node, messageId: "forwarding" });
      },
      ExportAllDeclaration(node) {
        if (
          node.exportKind !== "type" &&
          /^(?:react|ccstate|ccstate-react)(?:\/|$)/.test(node.source.value)
        )
          context.report({ node, messageId: "forwarding" });
      },
      ImportDeclaration(node) {
        if (
          node.importKind === "type" ||
          !/^ccstate(?:\/|$)/.test(node.source.value)
        )
          return;
        if (node.specifiers.every((item) => item.importKind === "type")) return;
        if (node.source.value !== "ccstate") {
          context.report({ node, messageId: "subpath" });
          return;
        }
        for (const item of node.specifiers) {
          if (item.importKind === "type") continue;
          if (item.type !== "ImportSpecifier") {
            context.report({ node: item, messageId: "canonical" });
            continue;
          }
          const name = item.imported.name ?? item.imported.value;
          if (!["state", "computed", "command"].includes(name)) continue;
          if (item.local.name !== name)
            context.report({ node: item, messageId: "canonical" });
        }
      },
    };
  },
};

export const privateState = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      escape:
        "Keep writable atoms private; expose computed projections and commands from a signal factory.",
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (
          node.init?.type !== "CallExpression" ||
          canonicalName(context, node.init.callee) !== "state"
        )
          return;
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          for (const reference of variable.references) {
            if (!reference.isRead()) continue;
            let parent = reference.identifier.parent;
            while (
              parent &&
              [
                "Property",
                "ObjectExpression",
                "ArrayExpression",
                "TSAsExpression",
                "TSSatisfiesExpression",
              ].includes(parent.type)
            )
              parent = parent.parent;
            if (
              parent &&
              ["ReturnStatement", "ExportSpecifier"].includes(parent.type)
            )
              context.report({
                node: reference.identifier,
                messageId: "escape",
              });
          }
        }
      },
    };
  },
};

export const noSuppression = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      suppression:
        "Fix the ownership boundary instead of suppressing checks or adding filename privileges.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (
            /(?:\b(?:eslint-disable|oxlint-disable)|@ts-(?:ignore|expect-error|nocheck))\b/.test(
              comment.value,
            )
          )
            context.report({ loc: comment.loc, messageId: "suppression" });
        }
      },
    };
  },
};
