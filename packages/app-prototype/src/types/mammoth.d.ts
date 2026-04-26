declare module 'mammoth/mammoth.browser' {
  export interface ConvertToHtmlInput {
    arrayBuffer: ArrayBuffer
  }
  export interface ConvertToHtmlResult {
    value: string
    messages: Array<{ type: string; message: string }>
  }
  export function convertToHtml(input: ConvertToHtmlInput): Promise<ConvertToHtmlResult>
}
