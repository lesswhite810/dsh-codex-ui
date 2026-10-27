import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
type HostRequest = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
};
declare class RequestBodyTooLargeError extends Error {}
/** 有界读取 Node HTTP body；业务接口只接受很小的 JSON。 */
declare function readRequestBody(request: HostRequest, maxBytes?: number): Promise<string>;
declare const inject: string[];
/** 提供不泄露地址、命令和凭证的连接器目录。 */
declare function apply(ctx: Context): void;
//#endregion
export { RequestBodyTooLargeError, apply, inject, readRequestBody };