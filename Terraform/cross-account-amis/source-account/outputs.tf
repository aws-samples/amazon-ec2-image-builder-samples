# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
output "kms_key_arn" {
  description = "Pass this to the target-account module as source_kms_key_arn."
  value       = aws_kms_key.image_encryption.arn
}

output "image_pipeline_arn" {
  description = "Run this pipeline once every target-account role is deployed."
  value       = aws_imagebuilder_image_pipeline.this.arn
}
