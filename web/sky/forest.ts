// The forest sky background draws a private star table and map, which are not part of the public snapshot.
export async function forest(_canvas: HTMLCanvasElement, _redraw: () => void): Promise<never> {
  throw new Error('this background is not part of the public build');
}
