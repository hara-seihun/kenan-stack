export const apiPath = (path: string): string => (window.location.pathname.startsWith('/pi-stack/') ? '/pi-stack' : '') + path;
