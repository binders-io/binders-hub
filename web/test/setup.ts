import { configure } from '@testing-library/react'

// Run before every test file: what a test waits to find is given ten seconds, not one. A screen is fetched when it's
// first shown, and on a busy machine that alone can take several.
configure({ asyncUtilTimeout: 10_000 })
