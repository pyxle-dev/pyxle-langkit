#!/usr/bin/env node
/**
 * JSX Component Extractor using Babel AST
 * 
 * Extracts specific JSX component usages (Script, Image, Head, ClientOnly)
 * with their props and children content.
 */

import { readFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';
import { parse } from '@babel/parser';
import babelTraverse from '@babel/traverse';

const traverse = babelTraverse.default || babelTraverse;

const [, , sourcePath, targetComponentsJson] = argv;

if (!sourcePath) {
  console.error(JSON.stringify({ ok: false, message: 'Expected path to JSX source file.' }));
  exit(1);
}

const targetComponents = targetComponentsJson && targetComponentsJson !== 'null' 
  ? JSON.parse(targetComponentsJson) 
  : null;

const parserOptions = {
  sourceType: 'module',
  plugins: [
    'jsx',
    'typescript',
    'classProperties',
    'classPrivateMethods',
    'decorators-legacy',
    'topLevelAwait',
  ],
  errorRecovery: false,
};

let source;
try {
  source = await readFile(sourcePath, 'utf8');
} catch (err) {
  console.error(JSON.stringify({ ok: false, message: `Failed to read source: ${err.message}` }));
  exit(1);
}

let ast;
try {
  ast = parse(source, parserOptions);
} catch (err) {
  console.error(JSON.stringify({ 
    ok: false, 
    message: err.message,
    line: err.loc?.line,
    column: err.loc?.column,
  }));
  exit(1);
}

// Guard: TypeScript syntax is not supported in a .pyxl client block.
//
// Babel parses with the `typescript` plugin (so a stray TS construct does not
// hard-fail here), but the client component is emitted as plain `.jsx` and
// bundled by esbuild's JSX loader, which does NOT strip TypeScript — it fails
// late with a parse error pointing into a generated `.pyxle-build` path instead
// of the user's `.pyxl` source. Catch it here so the compiler can report a
// clear, source-located error. Any AST node whose type starts with `TS` is a
// TypeScript-only construct; plain JS/JSX never produces one (a ternary is a
// ConditionalExpression, an object literal an ObjectProperty, a JSX `as` prop a
// JSXAttribute — none are `TS*`), so this has no false positives.
const TS_CONSTRUCT_LABELS = {
  TSTypeAnnotation: 'a type annotation (`: Type`)',
  TSAsExpression: 'an `as` type cast',
  TSSatisfiesExpression: 'a `satisfies` expression',
  TSNonNullExpression: 'a non-null assertion (`!`)',
  TSTypeAssertion: 'a type assertion (`<Type>expr`)',
  TSInterfaceDeclaration: 'an `interface` declaration',
  TSTypeAliasDeclaration: 'a `type` alias',
  TSEnumDeclaration: 'an `enum` declaration',
  TSModuleDeclaration: 'a `namespace` / `module` declaration',
  TSDeclareFunction: 'a `declare` statement',
  TSTypeParameterDeclaration: 'a generic type parameter (`<T>`)',
  TSTypeParameterInstantiation: 'a generic type argument (`<T>`)',
  TSParameterProperty: 'a parameter property modifier',
};

let tsViolation = null;
traverse(ast, {
  enter(path) {
    const nodeType = path.node.type;
    if (typeof nodeType === 'string' && nodeType.startsWith('TS')) {
      tsViolation = {
        type: nodeType,
        label: TS_CONSTRUCT_LABELS[nodeType] || 'TypeScript-only syntax',
        line: path.node.loc?.start.line ?? null,
        column: path.node.loc?.start.column ?? null,
      };
      path.stop();
    }
  },
});

if (tsViolation) {
  console.log(JSON.stringify({
    ok: false,
    code: 'ts_in_client_block',
    message:
      `TypeScript syntax (${tsViolation.label}) isn't supported in a .pyxl client block yet — ` +
      'keep the client half plain JSX (see docs/guides/typescript.md).',
    line: tsViolation.line,
    column: tsViolation.column,
  }));
  exit(0);
}

const components = [];

/**
 * Extract literal value from JSX attribute
 */
function extractPropValue(node) {
  if (!node) return null;
  
  // JSXExpressionContainer: {value}
  if (node.type === 'JSXExpressionContainer') {
    const expr = node.expression;
    
    // Literal values
    if (expr.type === 'StringLiteral' || expr.type === 'NumericLiteral' || expr.type === 'BooleanLiteral') {
      return expr.value;
    }
    
    // Keep JSX expressions as-is for the compiler to handle
    if (expr.type === 'Identifier' || expr.type === 'MemberExpression' || expr.type === 'CallExpression') {
      return `{${source.slice(expr.start, expr.end)}}`;
    }
    
    // For complex expressions, return the raw text
    return `{${source.slice(expr.start, expr.end)}}`;
  }
  
  // StringLiteral: "value" or 'value'
  if (node.type === 'StringLiteral') {
    return node.value;
  }
  
  // NumericLiteral: 42
  if (node.type === 'NumericLiteral') {
    return node.value;
  }
  
  return null;
}

/**
 * Extract props from JSX opening element
 */
function extractProps(openingElement) {
  const props = {};
  
  for (const attr of openingElement.attributes) {
    if (attr.type === 'JSXAttribute') {
      const name = attr.name.name;
      
      // Boolean attribute (no value)
      if (!attr.value) {
        props[name] = true;
        continue;
      }
      
      const value = extractPropValue(attr.value);
      if (value !== null) {
        props[name] = value;
      }
    } else if (attr.type === 'JSXSpreadAttribute') {
      // Handle spread attributes: {...props}
      props['__spread__'] = true;
    }
  }
  
  return props;
}

/**
 * Extract text content from JSX children
 */
function extractChildren(jsxElement) {
  if (!jsxElement.children || jsxElement.children.length === 0) {
    return null;
  }
  
  // For components like <Head>, extract the inner JSX/HTML
  const start = jsxElement.openingElement.end;
  const end = jsxElement.closingElement?.start ?? jsxElement.end;
  
  const content = source.slice(start, end).trim();
  return content || null;
}

/**
 * Traverse AST and find JSX elements
 */
traverse(ast, {
  JSXElement(path) {
    const node = path.node;
    const openingElement = node.openingElement;
    
    // Get component name
    const nameNode = openingElement.name;
    let componentName;
    
    if (nameNode.type === 'JSXIdentifier') {
      componentName = nameNode.name;
    } else if (nameNode.type === 'JSXMemberExpression') {
      // Handle <Foo.Bar />
      componentName = source.slice(nameNode.start, nameNode.end);
    } else {
      return; // Skip namespaced JSX
    }
    
    // Filter by target components if specified
    if (targetComponents && !targetComponents.includes(componentName)) {
      return;
    }
    
    // Extract props
    const props = extractProps(openingElement);
    
    // Extract children (for container components like <Head>)
    const children = extractChildren(node);
    
    // Check if self-closing
    const selfClosing = openingElement.selfClosing;
    
    // Add to results
    components.push({
      name: componentName,
      props,
      children,
      selfClosing,
      line: openingElement.loc?.start.line ?? null,
      column: openingElement.loc?.start.column ?? null,
    });
  },
});

// Output JSON result
console.log(JSON.stringify({ ok: true, components }));
