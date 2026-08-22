# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
variable "target_account_ids" {
  description = "Account IDs that receive their own copy of the output AMI. Each account needs the distribution role from ../target-account before the pipeline runs."
  type        = list(string)
  validation {
    condition     = length(var.target_account_ids) > 0 && alltrue([for id in var.target_account_ids : can(regex("^\\d{12}$", id))])
    error_message = "Each entry must be a 12-digit AWS account ID."
  }
}
