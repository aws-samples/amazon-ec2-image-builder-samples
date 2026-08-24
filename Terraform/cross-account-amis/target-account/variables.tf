# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
variable "source_account_id" {
  description = "The account that runs the Image Builder pipeline. Only this account can assume the distribution role - keep it pinned to the single source account you control."
  type        = string
  validation {
    condition     = can(regex("^\\d{12}$", var.source_account_id))
    error_message = "Must be a 12-digit AWS account ID."
  }
}

variable "source_kms_key_arn" {
  description = "ARN of the source account's customer managed key that encrypts the AMI (the kms_key_arn output of the source-account module)."
  type        = string
  validation {
    condition     = can(regex("^arn:aws[a-zA-Z-]*:kms:[a-z0-9-]+:\\d{12}:key/.+$", var.source_kms_key_arn))
    error_message = "Must be a KMS key ARN."
  }
}
