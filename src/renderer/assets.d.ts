// Static assets imported by the renderer (bundled by Vite, served from 'self').
declare module '*.png' {
  const url: string;
  export default url;
}
