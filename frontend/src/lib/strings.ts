export function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

export function countLabel(n: number, singular: string, plural?: string): string {
  return `${n.toLocaleString()} ${pluralize(n, singular, plural)}`;
}
