// Claude artifacts (and other single-file React components) as hosted charms.
//
// publish_app {react} compiles the JSX/TSX once, on our side, with Sucrase, and wraps it in a page that:
//   - loads React 18, Tailwind v3, lucide-react, recharts from CDNs (any other npm import comes from esm.sh),
//   - provides small stand-ins for the shadcn/ui components Claude artifacts import from @/components/ui/*,
//   - mounts the default export inside an error boundary, showing a readable message instead of a blank page.
// Claude's window.storage and window.claude shims live in runtime.js, so plain-HTML artifacts get them too.
// The original source is kept verbatim in the page (#charm-artifact) so get_app_source can hand it back.

import { transform } from 'sucrase';
import { ApiError } from './util.js';

const REACT = 'https://esm.sh/react@18.3.1';
export const IMPORTS = {
  react: REACT,
  'react/': `${REACT}/`,
  'react/jsx-runtime': `${REACT}/jsx-runtime`,
  'react-dom': 'https://esm.sh/react-dom@18.3.1?external=react',
  'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client?external=react',
  'lucide-react': 'https://esm.sh/lucide-react@0.460.0?external=react',
  recharts: 'https://esm.sh/recharts@2.12.7?external=react,react-dom',
  '@/components/ui/': '/runtime/ui/',
  '@/lib/utils': '/runtime/ui/utils',
};
export const TAILWIND = 'https://cdn.tailwindcss.com/3.4.16';

const MARKER = 'charmnomicon:react-artifact v1';

export function compileReact(source) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new ApiError(400, 'bad_field', '`react` must be the source of a React component (JSX or TSX).');
  }
  let code;
  try {
    code = transform(source, {
      transforms: ['jsx', 'typescript', 'imports'],
      jsxRuntime: 'automatic',
      production: true,
      filePath: 'artifact.tsx',
    }).code;
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error transforming [^:]+:\s*/, '');
    const at = /\((\d+):(\d+)\)/.exec(msg);
    throw new ApiError(400, 'react_syntax',
      `Could not compile \`react\`: ${msg}${at ? ` (line ${at[1]}, column ${Number(at[2]) + 1})` : ''}.`);
  }
  if (!/exports\.default\s*=/.test(code)) {
    throw new ApiError(400, 'react_no_default', '`react` needs a default export, e.g. `export default function App() { ... }`.');
  }
  return code;
}

const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** The hosted page for a React artifact. Returns the html string that gets stored like any other hosted charm. */
export function wrapReact({ title, source }) {
  const compiled = compileReact(source);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || 'Charm')}</title>
<!-- ${MARKER}: the original component source is in #charm-artifact. Change it with update_app {react}. -->
<script src="${TAILWIND}"></script>
<script type="importmap">${safeJson({ imports: IMPORTS })}</script>
<style>html, body { margin: 0; } #root { min-height: 100vh; }</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="charm-artifact">${safeJson({ format: 'react', source, compiled })}</script>
<script src="/runtime/react.js"></script>
</body>
</html>
`;
}

/** {format: 'react', source} when the stored html is a wrapped React artifact, else null. */
export function extractArtifact(html) {
  if (typeof html !== 'string' || !html.includes(MARKER)) return null;
  const m = /<script type="application\/json" id="charm-artifact">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    const a = JSON.parse(m[1]);
    return { format: a.format, source: a.source };
  } catch {
    return null;
  }
}

// --- served at /runtime/react.js (classic script, runs inside the sandboxed app) ---------------------------

export const LOADER_JS = `(() => {
  const show = (title, detail) => {
    let box = document.getElementById('charm-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'charm-error';
      box.setAttribute('style', 'position:fixed;inset:auto 12px 12px 12px;z-index:2147483646;background:#2b2140;color:#f6efe1;' +
        'font:14px/1.45 system-ui,sans-serif;padding:14px 16px;border-radius:14px;box-shadow:0 6px 24px #0005;max-height:45vh;overflow:auto');
      document.body.appendChild(box);
    }
    box.textContent = '';
    const b = document.createElement('b');
    b.textContent = '🔮 ' + title;
    const p = document.createElement('pre');
    p.setAttribute('style', 'white-space:pre-wrap;margin:8px 0 0;font:12px/1.4 ui-monospace,monospace;opacity:.9');
    p.textContent = String(detail || '');
    box.append(b, p);
  };
  addEventListener('error', (e) => show('This charm hit an error', e.message));
  addEventListener('unhandledrejection', (e) => show('This charm hit an error', (e.reason && e.reason.message) || e.reason));

  let art;
  try { art = JSON.parse(document.getElementById('charm-artifact').textContent); }
  catch (e) { show('This charm could not start', e.message); return; }
  const map = JSON.parse(document.querySelector('script[type="importmap"]').textContent).imports;
  const isMapped = (s) => s in map || Object.keys(map).some((k) => k.endsWith('/') && s.startsWith(k));
  const resolve = (s) => {
    if (isMapped(s) || /^(https?:)?\\/\\//.test(s) || s.startsWith('/')) return s;
    if (s.startsWith('.')) throw new Error('Relative import "' + s + '" is not available: a charm is a single file.');
    return 'https://esm.sh/' + s + (s.includes('?') ? '&' : '?') + 'external=react,react-dom';
  };
  const specs = [...new Set([...art.compiled.matchAll(/require\\((['"])([^'"]+)\\1\\)/g)].map((m) => m[2]))];
  const mods = {};
  // Sucrase output expects CommonJS-style modules; give it each ES module namespace with __esModule set,
  // so default imports get the module's default export and named imports work as usual.
  const asCjs = (ns) => Object.assign({}, ns, { __esModule: true, default: 'default' in ns ? ns.default : ns });

  Promise.all(specs.map(async (s) => { mods[s] = asCjs(await import(resolve(s))); }))
    .then(async () => {
      const React = await import('react');
      const { createRoot } = await import('react-dom/client');
      const require = (s) => {
        if (s in mods) return mods[s];
        throw new Error('Module "' + s + '" was not loaded.');
      };
      const module = { exports: {} };
      new Function('require', 'module', 'exports', art.compiled)(require, module, module.exports);
      const App = module.exports.default;
      if (typeof App !== 'function' && !(App && App.$$typeof)) {
        show('Nothing to show', 'The component needs a default export, e.g. export default function App() { ... }');
        return;
      }
      class Boundary extends React.Component {
        constructor(p) { super(p); this.state = { error: null }; }
        static getDerivedStateFromError(error) { return { error }; }
        componentDidCatch(error) { show('This charm hit an error', error && (error.stack || error.message)); }
        render() { return this.state.error ? null : this.props.children; }
      }
      createRoot(document.getElementById('root')).render(React.createElement(Boundary, null, React.createElement(App)));
    })
    .catch((e) => show('This charm could not load', e && (e.message || e)));
})();
`;

// --- served at /runtime/ui/<anything> (ES module): stand-ins for shadcn/ui ---------------------------------
// Claude artifacts import these from "@/components/ui/<name>". One module serves every name. They look close to
// shadcn's defaults and cover the common props; they are not full Radix implementations.

export const UI_JS = `import * as React from 'react';
const h = React.createElement;
const { createContext, useContext, useState, useEffect, useRef, forwardRef, cloneElement, isValidElement, Children } = React;

export function cn(...xs) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (typeof x === 'string' || typeof x === 'number') out.push(String(x));
    else if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === 'object') for (const k in x) if (x[k]) out.push(k);
  };
  xs.forEach(walk);
  return out.join(' ');
}
const el = (tag, base, name, extra) => {
  const C = forwardRef(({ className, ...p }, ref) => h(tag, { ref, className: cn(base, className), ...extra, ...p }));
  C.displayName = name;
  return C;
};
const useMaybeControlled = (value, def, onChange) => {
  const [inner, setInner] = useState(def);
  const v = value !== undefined ? value : inner;
  const set = (n) => { if (value === undefined) setInner(n); if (onChange) onChange(n); };
  return [v, set];
};
const asChildOr = (asChild, children, tag, props) => {
  if (asChild && isValidElement(children)) {
    const own = children.props.onClick;
    return cloneElement(children, { ...props, onClick: (e) => { if (own) own(e); if (props.onClick) props.onClick(e); } });
  }
  return h(tag, props, children);
};

export const Card = el('div', 'rounded-xl border border-gray-200 bg-white text-gray-950 shadow-sm', 'Card');
export const CardHeader = el('div', 'flex flex-col space-y-1.5 p-6', 'CardHeader');
export const CardTitle = el('h3', 'text-2xl font-semibold leading-none tracking-tight', 'CardTitle');
export const CardDescription = el('p', 'text-sm text-gray-500', 'CardDescription');
export const CardContent = el('div', 'p-6 pt-0', 'CardContent');
export const CardFooter = el('div', 'flex items-center p-6 pt-0', 'CardFooter');

const BTN = {
  default: 'bg-gray-900 text-white hover:bg-gray-800',
  destructive: 'bg-red-600 text-white hover:bg-red-700',
  outline: 'border border-gray-200 bg-white hover:bg-gray-100 text-gray-900',
  secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200',
  ghost: 'hover:bg-gray-100 text-gray-900',
  link: 'text-gray-900 underline-offset-4 hover:underline',
};
const SIZE = { default: 'h-10 px-4 py-2', sm: 'h-9 rounded-md px-3', lg: 'h-11 rounded-md px-8', icon: 'h-10 w-10' };
export const buttonVariants = ({ variant = 'default', size = 'default', className } = {}) => cn(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:pointer-events-none disabled:opacity-50',
  BTN[variant] || BTN.default, SIZE[size] || SIZE.default, className);
export const Button = forwardRef(({ className, variant, size, asChild, children, ...p }, ref) => {
  const cls = buttonVariants({ variant, size, className });
  if (asChild && isValidElement(children)) return cloneElement(children, { ...p, className: cn(cls, children.props.className) });
  return h('button', { ref, className: cls, ...p }, children);
});
Button.displayName = 'Button';

export const Input = forwardRef(({ className, ...p }, ref) => h('input', { ref, className: cn(
  'flex h-10 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm placeholder:text-gray-400 ' +
  'focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:cursor-not-allowed disabled:opacity-50', className), ...p }));
Input.displayName = 'Input';
export const Textarea = forwardRef(({ className, ...p }, ref) => h('textarea', { ref, className: cn(
  'flex min-h-[80px] w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm placeholder:text-gray-400 ' +
  'focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:cursor-not-allowed disabled:opacity-50', className), ...p }));
Textarea.displayName = 'Textarea';
export const Label = el('label', 'text-sm font-medium leading-none', 'Label');

const BADGE = {
  default: 'bg-gray-900 text-white', secondary: 'bg-gray-100 text-gray-900',
  destructive: 'bg-red-600 text-white', outline: 'border-gray-200 text-gray-900',
};
export const Badge = ({ className, variant = 'default', ...p }) => h('div', { className: cn(
  'inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-semibold', BADGE[variant] || BADGE.default, className), ...p });

export const Alert = ({ className, variant = 'default', ...p }) => h('div', { role: 'alert', className: cn(
  'relative w-full rounded-lg border p-4', variant === 'destructive' ? 'border-red-300 text-red-700' : 'border-gray-200 bg-white text-gray-950', className), ...p });
export const AlertTitle = el('h5', 'mb-1 font-medium leading-none tracking-tight', 'AlertTitle');
export const AlertDescription = el('div', 'text-sm', 'AlertDescription');

export const Separator = ({ className, orientation = 'horizontal', ...p }) => h('div', { role: 'separator', className: cn(
  'shrink-0 bg-gray-200', orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]', className), ...p });
export const Skeleton = el('div', 'animate-pulse rounded-md bg-gray-100', 'Skeleton');
export const Progress = ({ className, value = 0, ...p }) => h('div', { className: cn('relative h-4 w-full overflow-hidden rounded-full bg-gray-100', className), ...p },
  h('div', { className: 'h-full bg-gray-900 transition-all', style: { width: Math.max(0, Math.min(100, value || 0)) + '%' } }));

export const Switch = ({ checked, defaultChecked = false, onCheckedChange, disabled, className, ...p }) => {
  const [on, set] = useMaybeControlled(checked, defaultChecked, onCheckedChange);
  return h('button', { type: 'button', role: 'switch', 'aria-checked': on, disabled, onClick: () => set(!on), className: cn(
    'inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50', on ? 'bg-gray-900' : 'bg-gray-200', className), ...p },
    h('span', { className: cn('block h-5 w-5 rounded-full bg-white shadow transition-transform', on ? 'translate-x-5' : 'translate-x-0.5') }));
};
export const Checkbox = ({ checked, defaultChecked = false, onCheckedChange, disabled, className, ...p }) => {
  const [on, set] = useMaybeControlled(checked, defaultChecked, onCheckedChange);
  return h('button', { type: 'button', role: 'checkbox', 'aria-checked': on, disabled, onClick: () => set(!on), className: cn(
    'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-gray-900 text-[10px] leading-none disabled:opacity-50',
    on ? 'bg-gray-900 text-white' : 'bg-white', className), ...p }, on ? '✓' : null);
};
export const Slider = ({ value, defaultValue = [0], min = 0, max = 100, step = 1, onValueChange, onValueCommit, className, disabled }) => {
  const [v, set] = useMaybeControlled(value, defaultValue, onValueChange);
  return h('input', { type: 'range', min, max, step, disabled, value: (v && v[0]) ?? min, className: cn('w-full accent-gray-900', className),
    onChange: (e) => set([Number(e.target.value)]), onMouseUp: (e) => onValueCommit && onValueCommit([Number(e.target.value)]),
    onTouchEnd: (e) => onValueCommit && onValueCommit([Number(e.target.value)]) });
};
const RadioCtx = createContext(null);
export const RadioGroup = ({ value, defaultValue, onValueChange, className, children, ...p }) => {
  const [v, set] = useMaybeControlled(value, defaultValue, onValueChange);
  return h(RadioCtx.Provider, { value: { v, set } }, h('div', { role: 'radiogroup', className: cn('grid gap-2', className), ...p }, children));
};
export const RadioGroupItem = ({ value, className, id, disabled }) => {
  const ctx = useContext(RadioCtx) || {};
  const on = ctx.v === value;
  return h('button', { type: 'button', role: 'radio', id, disabled, 'aria-checked': on, onClick: () => ctx.set && ctx.set(value), className: cn(
    'flex aspect-square h-4 w-4 items-center justify-center rounded-full border border-gray-900', className) },
    on ? h('span', { className: 'h-2 w-2 rounded-full bg-gray-900' }) : null);
};
export const Toggle = ({ pressed, defaultPressed = false, onPressedChange, className, children, ...p }) => {
  const [on, set] = useMaybeControlled(pressed, defaultPressed, onPressedChange);
  return h('button', { type: 'button', 'aria-pressed': on, onClick: () => set(!on), className: cn(
    'inline-flex h-10 items-center justify-center rounded-md px-3 text-sm font-medium hover:bg-gray-100', on && 'bg-gray-100', className), ...p }, children);
};

const TabsCtx = createContext(null);
export const Tabs = ({ value, defaultValue, onValueChange, className, children, ...p }) => {
  const [v, set] = useMaybeControlled(value, defaultValue, onValueChange);
  return h(TabsCtx.Provider, { value: { v, set } }, h('div', { className, ...p }, children));
};
export const TabsList = el('div', 'inline-flex h-10 items-center justify-center rounded-md bg-gray-100 p-1 text-gray-500', 'TabsList', { role: 'tablist' });
export const TabsTrigger = ({ value, className, children, ...p }) => {
  const ctx = useContext(TabsCtx) || {};
  const on = ctx.v === value;
  return h('button', { type: 'button', role: 'tab', 'aria-selected': on, onClick: () => ctx.set && ctx.set(value), className: cn(
    'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all',
    on && 'bg-white text-gray-950 shadow-sm', className), ...p }, children);
};
export const TabsContent = ({ value, className, children, ...p }) => {
  const ctx = useContext(TabsCtx) || {};
  return ctx.v === value ? h('div', { role: 'tabpanel', className: cn('mt-2', className), ...p }, children) : null;
};

const SelectCtx = createContext(null);
const textOf = (children) => Children.toArray(children).map((c) => (typeof c === 'string' || typeof c === 'number' ? c : '')).join('');
export const Select = ({ value, defaultValue, onValueChange, disabled, children }) => {
  const [v, set] = useMaybeControlled(value, defaultValue, onValueChange);
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState({});
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const label = (val, text) => setLabels((l) => (l[val] === text ? l : { ...l, [val]: text }));
  return h(SelectCtx.Provider, { value: { v, set, open, setOpen, labels, label, disabled } }, h('div', { ref, className: 'relative' }, children));
};
export const SelectTrigger = ({ className, children, ...p }) => {
  const ctx = useContext(SelectCtx) || {};
  return h('button', { type: 'button', disabled: ctx.disabled, 'aria-expanded': !!ctx.open, onClick: () => ctx.setOpen(!ctx.open), className: cn(
    'flex h-10 w-full items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2 text-sm disabled:opacity-50', className), ...p },
    children, h('span', { 'aria-hidden': true, className: 'ml-2 opacity-50' }, '▾'));
};
export const SelectValue = ({ placeholder }) => {
  const ctx = useContext(SelectCtx) || {};
  const has = ctx.v !== undefined && ctx.v !== null && ctx.v !== '';
  return h('span', { className: has ? '' : 'text-gray-400' }, has ? (ctx.labels[ctx.v] || String(ctx.v)) : (placeholder || ''));
};
export const SelectContent = ({ className, children }) => {
  const ctx = useContext(SelectCtx) || {};
  return h('div', { role: 'listbox', style: ctx.open ? undefined : { display: 'none' }, className: cn(
    'absolute z-50 mt-1 max-h-72 w-full min-w-[8rem] overflow-auto rounded-md border border-gray-200 bg-white p-1 shadow-md', className) }, children);
};
export const SelectItem = ({ value, className, children, disabled }) => {
  const ctx = useContext(SelectCtx) || {};
  const text = textOf(children);
  useEffect(() => { if (ctx.label) ctx.label(value, text); }, [value, text]);
  const on = ctx.v === value;
  return h('div', { role: 'option', 'aria-selected': on, onClick: () => { if (!disabled) { ctx.set(value); ctx.setOpen(false); } }, className: cn(
    'relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm hover:bg-gray-100', disabled && 'opacity-50', className) },
    on ? h('span', { className: 'absolute left-2' }, '✓') : null, children);
};
export const SelectGroup = el('div', '', 'SelectGroup');
export const SelectLabel = el('div', 'py-1.5 pl-8 pr-2 text-sm font-semibold', 'SelectLabel');
export const SelectSeparator = el('div', '-mx-1 my-1 h-px bg-gray-100', 'SelectSeparator');

const DialogCtx = createContext(null);
export const Dialog = ({ open, defaultOpen = false, onOpenChange, children }) => {
  const [o, set] = useMaybeControlled(open, defaultOpen, onOpenChange);
  return h(DialogCtx.Provider, { value: { open: o, set } }, children);
};
export const DialogTrigger = ({ asChild, children, ...p }) => {
  const ctx = useContext(DialogCtx) || {};
  return asChildOr(asChild, children, 'button', { type: 'button', ...p, onClick: () => ctx.set(true) });
};
export const DialogClose = ({ asChild, children, ...p }) => {
  const ctx = useContext(DialogCtx) || {};
  return asChildOr(asChild, children, 'button', { type: 'button', ...p, onClick: () => ctx.set(false) });
};
export const DialogContent = ({ className, children, ...p }) => {
  const ctx = useContext(DialogCtx) || {};
  if (!ctx.open) return null;
  return h('div', { className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4', onClick: () => ctx.set(false) },
    h('div', { role: 'dialog', onClick: (e) => e.stopPropagation(), className: cn(
      'relative grid w-full max-w-lg gap-4 rounded-lg border border-gray-200 bg-white p-6 shadow-lg', className), ...p },
      children,
      h('button', { type: 'button', 'aria-label': 'Close', onClick: () => ctx.set(false), className: 'absolute right-4 top-3 text-lg opacity-60 hover:opacity-100' }, '×')));
};
export const DialogHeader = el('div', 'flex flex-col space-y-1.5 text-center sm:text-left', 'DialogHeader');
export const DialogFooter = el('div', 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', 'DialogFooter');
export const DialogTitle = el('h2', 'text-lg font-semibold leading-none tracking-tight', 'DialogTitle');
export const DialogDescription = el('p', 'text-sm text-gray-500', 'DialogDescription');
export const AlertDialog = Dialog;
export const AlertDialogTrigger = DialogTrigger;
export const AlertDialogContent = DialogContent;
export const AlertDialogHeader = DialogHeader;
export const AlertDialogFooter = DialogFooter;
export const AlertDialogTitle = DialogTitle;
export const AlertDialogDescription = DialogDescription;
export const AlertDialogAction = ({ className, onClick, children, ...p }) => {
  const ctx = useContext(DialogCtx) || {};
  return h('button', { type: 'button', className: buttonVariants({ className }), onClick: (e) => { if (onClick) onClick(e); ctx.set(false); }, ...p }, children);
};
export const AlertDialogCancel = ({ className, onClick, children, ...p }) => {
  const ctx = useContext(DialogCtx) || {};
  return h('button', { type: 'button', className: buttonVariants({ variant: 'outline', className }), onClick: (e) => { if (onClick) onClick(e); ctx.set(false); }, ...p }, children);
};

const PopCtx = createContext(null);
export const Popover = ({ open, defaultOpen = false, onOpenChange, children }) => {
  const [o, set] = useMaybeControlled(open, defaultOpen, onOpenChange);
  return h(PopCtx.Provider, { value: { open: o, set } }, h('div', { className: 'relative inline-block' }, children));
};
export const PopoverTrigger = ({ asChild, children, ...p }) => {
  const ctx = useContext(PopCtx) || {};
  return asChildOr(asChild, children, 'button', { type: 'button', ...p, onClick: () => ctx.set(!ctx.open) });
};
export const PopoverContent = ({ className, children, ...p }) => {
  const ctx = useContext(PopCtx) || {};
  return ctx.open ? h('div', { className: cn('absolute z-50 mt-2 w-72 rounded-md border border-gray-200 bg-white p-4 shadow-md', className), ...p }, children) : null;
};

export const TooltipProvider = ({ children }) => children;
export const Tooltip = ({ children }) => children;
export const TooltipTrigger = ({ asChild, children, ...p }) => (asChild && isValidElement(children) ? children : h('span', p, children));
export const TooltipContent = () => null;

export const ScrollArea = el('div', 'relative overflow-auto', 'ScrollArea');
export const ScrollBar = () => null;
export const Avatar = el('span', 'relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full', 'Avatar');
export const AvatarImage = ({ className, ...p }) => h('img', { className: cn('aspect-square h-full w-full object-cover', className), ...p });
export const AvatarFallback = el('span', 'flex h-full w-full items-center justify-center rounded-full bg-gray-100', 'AvatarFallback');

const AccCtx = createContext(null);
const AccItemCtx = createContext(null);
export const Accordion = ({ type = 'single', value, defaultValue, onValueChange, className, children, ...p }) => {
  const init = defaultValue ?? (type === 'multiple' ? [] : '');
  const [v, set] = useMaybeControlled(value, init, onValueChange);
  const isOpen = (k) => (Array.isArray(v) ? v.includes(k) : v === k);
  const toggle = (k) => {
    if (type === 'multiple') set(isOpen(k) ? v.filter((x) => x !== k) : [...(v || []), k]);
    else set(isOpen(k) ? '' : k);
  };
  return h(AccCtx.Provider, { value: { isOpen, toggle } }, h('div', { className, ...p }, children));
};
export const AccordionItem = ({ value, className, children, ...p }) => h(AccItemCtx.Provider, { value },
  h('div', { className: cn('border-b border-gray-200', className), ...p }, children));
export const AccordionTrigger = ({ className, children, ...p }) => {
  const acc = useContext(AccCtx) || {};
  const k = useContext(AccItemCtx);
  return h('button', { type: 'button', 'aria-expanded': acc.isOpen(k), onClick: () => acc.toggle(k), className: cn(
    'flex w-full flex-1 items-center justify-between py-4 font-medium hover:underline', className), ...p },
    children, h('span', { 'aria-hidden': true, className: 'opacity-50' }, acc.isOpen(k) ? '▴' : '▾'));
};
export const AccordionContent = ({ className, children, ...p }) => {
  const acc = useContext(AccCtx) || {};
  const k = useContext(AccItemCtx);
  return acc.isOpen(k) ? h('div', { className: cn('pb-4 pt-0 text-sm', className), ...p }, children) : null;
};

export const Table = ({ className, ...p }) => h('div', { className: 'relative w-full overflow-auto' }, h('table', { className: cn('w-full caption-bottom text-sm', className), ...p }));
export const TableHeader = el('thead', '[&_tr]:border-b', 'TableHeader');
export const TableBody = el('tbody', '[&_tr:last-child]:border-0', 'TableBody');
export const TableFooter = el('tfoot', 'border-t bg-gray-50 font-medium', 'TableFooter');
export const TableRow = el('tr', 'border-b border-gray-200 transition-colors hover:bg-gray-50', 'TableRow');
export const TableHead = el('th', 'h-12 px-4 text-left align-middle font-medium text-gray-500', 'TableHead');
export const TableCell = el('td', 'p-4 align-middle', 'TableCell');
export const TableCaption = el('caption', 'mt-4 text-sm text-gray-500', 'TableCaption');

// toasts: log instead of rendering, so artifacts that call toast() keep working
export const useToast = () => ({ toast: (t) => console.log('[toast]', (t && (t.title || t.description)) || t), dismiss: () => {}, toasts: [] });
export const toast = (t) => console.log('[toast]', (t && (t.title || t.description)) || t);
export const Toaster = () => null;
`;
