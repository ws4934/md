import { buildDesktopBundles } from './build'

// Integration tests spawn the bundled agents from dist/. Building once here keeps
// parallel test files from wiping and recopying dist/ under each other.
export default async function setup(): Promise<void> {
  await buildDesktopBundles()
}
