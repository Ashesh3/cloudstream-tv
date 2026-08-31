export interface TvAstryxCssInput {
  coreCss: string;
  themeCss: string;
}

export function resolveDarkFunctions(value: string): string;
export function unScopeThemeCss(css: string, themeRoot?: string): string;
export function transformTvAstryxCss(input: TvAstryxCssInput): string;
