/**
 * Rich translations for JSX sentences (renderer only).
 *
 *   trx('Bấm <0>Lưu</0> để tiếp tục, còn {{n}} tin', { 0: <strong className="font-semibold" />, n })
 *
 * `<0>…</0>` / `<0/>` take the element `parts[0]`; the tag content replaces the element children. `{{name}}` inserts
 * `parts.name` as a node, so strings, numbers and elements all work. In Vietnamese the result renders the same nodes
 * as the JSX sentence it replaced (the codemod in scripts/i18n builds these calls).
 */
import React from 'react';
import { contextKey, resolveTemplate, type TrVars } from '../../../shared/i18n/runtime';

export type TrxParts = Record<string, React.ReactNode>;

const TOKEN_RE = /<(\d+)\s*\/>|<(\d+)>|<\/(\d+)>|\{\{([A-Za-z_$][\w$]*)\}\}/g;

function pluralVars(parts?: TrxParts): TrVars | undefined {
  if (!parts) return undefined;
  const vars: TrVars = {};
  for (const [name, value] of Object.entries(parts)) {
    if (!/^\d+$/.test(name) && (typeof value === 'number' || typeof value === 'string')) vars[name] = value;
  }
  return vars;
}

function render(template: string, parts?: TrxParts): React.ReactNode {
  type Frame = { tag: string | null; children: React.ReactNode[] };
  const root: Frame = { tag: null, children: [] };
  const stack: Frame[] = [root];
  const top = () => stack[stack.length - 1];
  const element = (tag: string, children: React.ReactNode[] | null) => {
    const el = parts?.[tag];
    if (React.isValidElement(el)) return children ? React.cloneElement(el, undefined, ...children) : el;
    return children ? React.createElement(React.Fragment, null, ...children) : null;
  };

  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (let match = TOKEN_RE.exec(template); match; match = TOKEN_RE.exec(template)) {
    if (match.index > last) top().children.push(template.slice(last, match.index));
    last = match.index + match[0].length;
    const [raw, selfClosing, open, close, name] = match;
    if (selfClosing !== undefined) {
      top().children.push(element(selfClosing, null));
    } else if (open !== undefined) {
      stack.push({ tag: open, children: [] });
    } else if (close !== undefined) {
      if (stack.length > 1 && top().tag === close) {
        const frame = stack.pop()!;
        top().children.push(element(close, frame.children));
      } else {
        top().children.push(raw);
      }
    } else if (name !== undefined) {
      top().children.push(parts && Object.prototype.hasOwnProperty.call(parts, name) ? parts[name] : raw);
    }
  }
  if (last < template.length) top().children.push(template.slice(last));
  // An unclosed tag (bad translation) renders its text instead of dropping it
  while (stack.length > 1) {
    const frame = stack.pop()!;
    top().children.push(`<${frame.tag}>`, ...frame.children);
  }
  return React.createElement(React.Fragment, null, ...root.children);
}

export function trx(source: string, parts?: TrxParts): React.ReactNode {
  return render(resolveTemplate(source, source, pluralVars(parts)), parts);
}

export function trxc(context: string, source: string, parts?: TrxParts): React.ReactNode {
  return render(resolveTemplate(contextKey(context, source), source, pluralVars(parts)), parts);
}
