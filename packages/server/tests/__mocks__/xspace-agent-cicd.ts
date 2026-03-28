// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// Stub mock for xspace-agent/cicd sub-path
export const CICDService = class MockCICDService {
  deploy() {}
  rollback() {}
}
export type DeploymentEnvironment = string
export type AgentTest = any
