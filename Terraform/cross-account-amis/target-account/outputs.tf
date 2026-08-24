# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
output "distribution_role_arn" {
  description = "Role Image Builder assumes from the source account."
  value       = aws_iam_role.distribution.arn
}
