/** File extension → language, for the local language breakdown of the Code tab. */
const BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', cs: 'C#', fs: 'F#', swift: 'Swift', m: 'Objective-C', mm: 'Objective-C++',
  php: 'PHP', pl: 'Perl', lua: 'Lua', r: 'R', dart: 'Dart', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell', clj: 'Clojure', zig: 'Zig', nim: 'Nim',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less', vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', psm1: 'PowerShell', bat: 'Batchfile', cmd: 'Batchfile',
  sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protocol Buffer', tf: 'HCL', hcl: 'HCL', dockerfile: 'Dockerfile', makefile: 'Makefile',
  sol: 'Solidity', ipynb: 'Jupyter Notebook', groovy: 'Groovy', gradle: 'Groovy', vb: 'Visual Basic', jl: 'Julia', ml: 'OCaml', elm: 'Elm',
};

export const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572A5', Ruby: '#701516', Go: '#00ADD8', Rust: '#dea584', Java: '#b07219', Kotlin: '#A97BFF',
  C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', Swift: '#F05138', PHP: '#4F5D95', HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c', Vue: '#41b883',
  Svelte: '#ff3e00', Shell: '#89e051', PowerShell: '#012456', Dart: '#00B4AB', Dockerfile: '#384d54', Makefile: '#427819', SQL: '#e38c00', Lua: '#000080',
  Elixir: '#6e4a7e', Haskell: '#5e5086', Scala: '#c22d40', 'Objective-C': '#438eff', HCL: '#844FBA', Batchfile: '#C1F12E', Perl: '#0298c3', R: '#198CE7',
  'Jupyter Notebook': '#DA5B0B', Less: '#1d365d', Sass: '#a53b70', Astro: '#ff5a03', GraphQL: '#e10098', Solidity: '#AA6746', Groovy: '#4298b8',
};

export const languageColor = (lang: string): string => LANGUAGE_COLORS[lang] ?? '#8b949e';

/** Paths that GitHub's linguist also ignores: dependencies, build output, generated and minified files. */
const VENDORED = /(^|\/)(node_modules|vendor|dist|build|out|\.next|coverage|third_party|bower_components)\/|\.min\.(js|css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

export function languageOf(path: string): string | null {
  if (VENDORED.test(path)) return null;
  const base = path.split('/').pop()!.toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'Dockerfile';
  if (base === 'makefile') return 'Makefile';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? (BY_EXT[base.slice(dot + 1)] ?? null) : null;
}
