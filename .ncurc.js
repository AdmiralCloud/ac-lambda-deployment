module.exports = {
  // archiver v8 is ESM-only with a completely redesigned API (no more require/factory function)
  // Migration requires switching to ESM and rewriting the archiver usage — block major updates only
  target: (name) => {
    if (name === 'archiver') return 'minor'
    return 'latest'
  }
}
