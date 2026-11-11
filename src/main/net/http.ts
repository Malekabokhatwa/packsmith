import { guardedJson, guardedRequest, type GuardOptions, type GuardedResponse } from "./guard";

// What the content sources need from the network. Production passes the guard; unit tests
// pass recorded fixtures (spec 11.1: no live calls in unit tests).
export interface Http {
  json(url: string, opts?: GuardOptions): Promise<unknown>;
  request(url: string, opts?: GuardOptions): Promise<GuardedResponse>;
}

export const guardedHttp: Http = { json: guardedJson, request: guardedRequest };
