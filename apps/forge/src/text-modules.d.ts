// Markdown and CSV files bundled as text (wrangler.jsonc "rules").
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.csv" {
  const text: string;
  export default text;
}
