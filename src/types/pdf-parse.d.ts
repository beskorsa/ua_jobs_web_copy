// pdf-parse не публикует собственные типы — минимальная декларация под то,
// что реально используется в src/lib/resumes.ts.
declare module "pdf-parse" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }

  function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>;
  export default pdfParse;
}
