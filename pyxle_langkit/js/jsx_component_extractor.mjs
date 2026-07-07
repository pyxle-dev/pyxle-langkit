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

// Babel error classes that mean "some open JSX tag was never closed". Babel
// anchors these at the DETECTION site — `UnterminatedJsxContent` at the end of
// the snippet (naming no tag at all), `MissingClosingTag*` at whichever LATER
// closing tag exposed the problem — so the diagnostic drifts away from the tag
// the user actually forgot to close. For these we locate the innermost unclosed
// open tag ourselves (see findInnermostUnclosedTag) and re-anchor there.
const UNCLOSED_TAG_REASONS = new Set([
  'UnterminatedJsxContent',
  'MissingClosingTagElement',
  'MissingClosingTagFragment',
]);

// Synthetic closing tag spliced in while healing an `UnterminatedJsxContent`
// failure so Babel's error recovery can produce an AST. Unclosed elements are
// detected by closing-tag POSITION (inside a spliced probe), never by this
// name, so a user tag can't collide with it.
const HEALING_CLOSER = '</__pyxleUnclosedTagProbe__>';

/** Qualified JSX tag name (`Foo`, `Foo.Bar`, `svg:path`) for a JSX name node. */
function jsxTagName(nameNode) {
  switch (nameNode.type) {
    case 'JSXIdentifier':
      return nameNode.name;
    case 'JSXNamespacedName':
      return `${nameNode.namespace.name}:${nameNode.name.name}`;
    case 'JSXMemberExpression':
      return `${jsxTagName(nameNode.object)}.${jsxTagName(nameNode.property)}`;
    default:
      return null;
  }
}

/** 1-based line and 0-based column (Babel convention) of `index` in `text`. */
function lineColumnAt(text, index) {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: index - lastBreak - 1 };
}

/**
 * Walk a recovered AST and collect every JSX element/fragment whose closing
 * tag is missing, synthetic (a spliced-in healing closer), or stolen from an
 * enclosing element (Babel pairs a closing tag with the innermost open
 * element, so `<div><section></div>` closes `<section>` with `</div>`). A
 * mismatched closing tag whose name matches NO enclosing open tag (a
 * `</sektion>` typo) is a mismatched close, not an unclosed tag, and is
 * deliberately not collected.
 *
 * Candidates carry `name: null` for fragments (`<>`), plus their nesting depth
 * and opening-tag start so the innermost one can be chosen.
 */
function collectUnclosedCandidates(program, isSynthetic) {
  const candidates = [];
  const ancestors = [];

  const closerMatchesAncestor = (closing) => {
    if (closing.type === 'JSXClosingFragment') {
      return ancestors.some((node) => node.type === 'JSXFragment');
    }
    const closeName = jsxTagName(closing.name);
    return (
      closeName !== null
      && ancestors.some(
        (node) =>
          node.type === 'JSXElement'
          && jsxTagName(node.openingElement.name) === closeName,
      )
    );
  };

  const isUnclosed = (closing, openName) => {
    if (!closing) return true;
    if (isSynthetic(closing.start)) return true; // spliced healing closer
    if (closing.type === 'JSXClosingFragment') {
      // A `</>` legitimately closes only a fragment; on an element it was
      // stolen from an enclosing fragment.
      return openName !== null && closerMatchesAncestor(closing);
    }
    const closeName = jsxTagName(closing.name);
    if (closeName === openName) return false;
    return closerMatchesAncestor(closing);
  };

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node.type !== 'string') return;

    const isElement = node.type === 'JSXElement';
    const isFragment = node.type === 'JSXFragment';
    if (isElement || isFragment) {
      const opening = isElement ? node.openingElement : node.openingFragment;
      const closing = isElement ? node.closingElement : node.closingFragment;
      const openName = isElement ? jsxTagName(node.openingElement.name) : null;
      if ((isFragment || !opening.selfClosing) && isUnclosed(closing, openName)) {
        candidates.push({
          name: openName,
          depth: ancestors.length,
          start: opening.start,
        });
      }
      ancestors.push(node);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
      visit(node[key]);
    }
    if (isElement || isFragment) ancestors.pop();
  };

  visit(program);
  return candidates;
}

// Closers spliced while healing when Babel dies with unexpected end-of-input:
// an unclosed `(`, `{`, or `[` after the JSX stays FATAL even under error
// recovery, so a truncated snippet (or one whose trailing `);` was swallowed
// into JSX text) needs its bracket closed too before an AST can come out.
const BRACKET_CLOSERS = [')', '}', ']'];
// At most this many bracket closers may be appended along one healing branch;
// real snippets rarely truncate more than a couple of brackets deep.
const BRACKET_LIMIT = 8;
// Line boundaries tried as closer splice points per failure, counted from the
// end of the failing JSX-text region (see closerSpliceCandidates).
const LINE_BOUNDARY_LIMIT = 32;
// Total parse attempts allowed across ALL healing branches, so backtracking
// stays cheap even on pathological input.
const PARSE_BUDGET = 64;

/**
 * Candidate splice points (in ORIGINAL source coordinates) for one
 * `UnterminatedJsxContent` failure whose JSX-text token starts at `textStart`
 * (healed coordinates) and runs to end-of-input, in the order they should be
 * tried:
 *
 * 1. The failing token's START — right after the last complete child, so
 *    trailing real code (`);` / `}`) is re-lexed as code. Heals every
 *    element-children geometry and is tried first to keep those byte-stable.
 * 2. Each LINE BOUNDARY inside the failing text region, latest-first (bounded
 *    to `LINE_BOUNDARY_LIMIT`), plus end-of-input. Bare-text children make
 *    splice point 1 eject that text out of JSX (a fatal `Unexpected token`),
 *    but splicing at the newline after the last text line — before the `);`
 *    line — keeps the text inside the element and parses.
 */
function closerSpliceCandidates(healed, textStart, toOriginalIndex) {
  const boundaries = [healed.length];
  for (let i = healed.indexOf('\n', textStart); i !== -1; i = healed.indexOf('\n', i + 1)) {
    boundaries.push(i + 1);
  }
  boundaries.sort((a, b) => b - a);
  const candidates = [];
  const seen = new Set();
  for (const healedIndex of [textStart, ...boundaries.slice(0, LINE_BOUNDARY_LIMIT)]) {
    const original = toOriginalIndex(healedIndex);
    if (original === null || seen.has(original)) continue;
    seen.add(original);
    candidates.push(original);
  }
  return candidates;
}

/**
 * Parse `src` with `errorRecovery: true`, splicing in healing text until an
 * AST comes out.
 *
 * Two failure classes stay fatal even under error recovery and are healed by
 * a depth-first search over splice points (each recursion step adds ONE
 * insertion, then reparses; a branch whose parse dies differently is
 * abandoned and the next candidate is tried):
 *
 * - `UnterminatedJsxContent` (the tokenizer hits end-of-input while lexing
 *   JSX text): one `HEALING_CLOSER` is spliced in at each candidate from
 *   `closerSpliceCandidates`, at most `closerLimit` closers per branch.
 * - `UnexpectedToken` exactly AT end-of-input (an unclosed `(`/`{`/`[` left
 *   over after the JSX healed — e.g. the snippet is truncated, or a closer
 *   spliced at end-of-input swallowed the trailing `);` into JSX text): each
 *   `BRACKET_CLOSERS` character is appended, at most `BRACKET_LIMIT` per
 *   branch. Wrong brackets die on the next parse and are backtracked.
 *
 * Insertions are tracked in ORIGINAL source coordinates; the returned
 * `toOriginalIndex` maps a healed-source index back (or to `null` when it
 * falls inside spliced text, i.e. is synthetic).
 *
 * Returns `{ ast, toOriginalIndex }`, or null when a branch-limit or the
 * global `PARSE_BUDGET` is exhausted, or every branch hits an unhealable
 * fatal error.
 */
function parseWithHealing(src, closerLimit) {
  let budget = PARSE_BUDGET;

  const attempt = (insertions, closersUsed, bracketsUsed) => {
    if (budget <= 0) return null;
    budget -= 1;
    // Stable sort: insertions at the SAME index keep insertion order, so an
    // end-of-input `</probe>` + `)` + `}` sequence heals in the order added.
    const sorted = insertions.slice().sort((a, b) => a.at - b.at);
    let healed = '';
    let previous = 0;
    for (const insertion of sorted) {
      healed += src.slice(previous, insertion.at) + insertion.text;
      previous = insertion.at;
    }
    healed += src.slice(previous);
    const toOriginalIndex = (healedIndex) => {
      let shift = 0;
      for (const insertion of sorted) {
        const start = insertion.at + shift;
        if (healedIndex < start) break;
        if (healedIndex < start + insertion.text.length) return null;
        shift += insertion.text.length;
      }
      return healedIndex - shift;
    };

    let recoveryErr;
    try {
      const ast = parse(healed, { ...parserOptions, errorRecovery: true });
      return { ast, toOriginalIndex };
    } catch (caught) {
      recoveryErr = caught;
    }

    const errIndex = recoveryErr?.loc?.index;
    if (typeof errIndex !== 'number') return null;
    if (recoveryErr.reasonCode === 'UnterminatedJsxContent' && closersUsed < closerLimit) {
      for (const at of closerSpliceCandidates(healed, errIndex, toOriginalIndex)) {
        const healedResult = attempt(
          [...insertions, { at, text: HEALING_CLOSER }],
          closersUsed + 1,
          bracketsUsed,
        );
        if (healedResult) return healedResult;
      }
    } else if (
      recoveryErr.reasonCode === 'UnexpectedToken'
      && errIndex === healed.length
      && bracketsUsed < BRACKET_LIMIT
    ) {
      for (const bracket of BRACKET_CLOSERS) {
        const healedResult = attempt(
          [...insertions, { at: src.length, text: bracket }],
          closersUsed,
          bracketsUsed + 1,
        );
        if (healedResult) return healedResult;
      }
    }
    return null;
  };

  return attempt([], 0, 0);
}

/**
 * Find the innermost unclosed open tag in `src`. Returns
 * `{ name, line, column }` (`name: null` for a fragment; line 1-based, column
 * 0-based, both in `src` coordinates), or null when there is no unclosed tag —
 * e.g. the error is really a mismatched closing tag.
 */
function findInnermostUnclosedTag(src) {
  const closerLimit = Math.min(64, (src.match(/</g) ?? []).length);
  const healing = parseWithHealing(src, closerLimit);
  if (healing === null) return null;
  const candidates = collectUnclosedCandidates(
    healing.ast.program,
    (index) => healing.toOriginalIndex(index) === null,
  );
  if (candidates.length === 0) return null; // mismatched close, not unclosed
  // Innermost first; among candidates at the same depth, the latest open tag.
  candidates.sort((a, b) => b.depth - a.depth || b.start - a.start);
  const originalStart = healing.toOriginalIndex(candidates[0].start);
  if (originalStart === null) return null;
  return { name: candidates[0].name, ...lineColumnAt(src, originalStart) };
}

let ast;
try {
  ast = parse(source, parserOptions);
} catch (err) {
  // An unclosed tag: re-anchor at the offending OPEN tag and always name it,
  // instead of Babel's detection-site anchor (a later closing tag, or a
  // tag-less "Unterminated JSX contents." at the end of the snippet).
  // Mismatched closing tags (`</sektion>` typo) yield no unclosed candidate
  // and keep Babel's message below, unchanged.
  if (UNCLOSED_TAG_REASONS.has(err.reasonCode)) {
    const unclosed = findInnermostUnclosedTag(source);
    if (unclosed) {
      const tag = unclosed.name === null ? '<>' : `<${unclosed.name}>`;
      const fix = unclosed.name === null
        ? 'add the matching `</>`'
        : `add the matching \`</${unclosed.name}>\` or make the tag self-closing`;
      console.error(JSON.stringify({
        ok: false,
        code: 'unclosed_jsx_tag',
        message: `${tag} is never closed — ${fix}.`,
        line: unclosed.line,
        column: unclosed.column,
      }));
      exit(1);
    }
  }
  // Babel appends the failure's (line:col) to its message, but that coordinate
  // is relative to the extracted JSX snippet — not the .pyxl file. The compiler
  // maps err.loc and reports the real file line separately, so strip the
  // misleading in-message coordinate here.
  let message = err.message.replace(/\s*\(\d+:\d+\)\s*$/, '');
  // Babel misreports an unclosed `{ ... }` expression (or a stray `<`) in JSX as
  // "Unterminated regular expression" — it lexes the `/` in a later `</tag>` as
  // the start of a regex literal. Add a hint so the real cause is obvious to a
  // human or an agent reading the diagnostic.
  if (/Unterminated regular expression/i.test(message)) {
    message += ' — this usually means an unclosed `{ }` expression or JSX tag earlier in the markup.';
  }
  console.error(JSON.stringify({
    ok: false,
    message,
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

// Guard: a module may have only one `export default`.
//
// @babel/parser does NOT enforce this (it parses two default exports without
// error), but esbuild — which bundles the client at build time — fails on it.
// Without this check a duplicate default export sails through `pyxle check` and
// only breaks later at build, with an error pointing into a generated
// `.pyxle-build` path. Catch it here so the diagnostic is source-located.
const defaultExports = ast.program.body.filter(
  (node) => node.type === 'ExportDefaultDeclaration',
);
if (defaultExports.length > 1) {
  const second = defaultExports[1];
  console.log(JSON.stringify({
    ok: false,
    code: 'duplicate_default_export',
    message:
      `Multiple \`export default\` statements (${defaultExports.length}) — a module may ` +
      'have only one default export. This breaks the build (esbuild); keep a single ' +
      'default-exported page component.',
    line: second.loc?.start.line ?? null,
    column: second.loc?.start.column ?? null,
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
