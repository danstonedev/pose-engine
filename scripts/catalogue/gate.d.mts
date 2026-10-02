export const MASTER_PATH: string;
export function readMaster(root: string): { data: any; tracking: any };
export function changedContexts(data: any): any[];
export function contextKey(context: any): string;
export function reviewKey(context: any): string;
export function evaluateCatalogue(data: any, tracking: any, options?: any): any;
export function assertGate(result: any): void;
