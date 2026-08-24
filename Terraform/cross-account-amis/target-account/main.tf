# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

# Image Builder looks this role up by its fixed, service-defined name when
# it distributes to this account - a role with any other name is never
# assumed, and distribution fails as if no role existed.
resource "aws_iam_role" "distribution" {
  name = "EC2ImageBuilderDistributionCrossAccountRole"

  # Image Builder assumes this role FROM the source account, so the trusted
  # principal is the source account root - not the imagebuilder.amazonaws.com
  # service principal. Widening this to '*' or an organization path lets
  # every matching account push AMIs into this account and write its SSM
  # parameters.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${var.source_account_id}:root" }
        Action    = "sts:AssumeRole"
      },
    ]
  })
}

# The EC2 side of receiving a copy: CopyImage and the related EC2 actions
# the service performs in this account.
resource "aws_iam_role_policy_attachment" "cross_account_distribution" {
  role       = aws_iam_role.distribution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/Ec2ImageBuilderCrossAccountDistributionAccess"
}

resource "aws_iam_role_policy" "additions" {
  name = "CrossAccountDistributionAdditions"
  role = aws_iam_role.distribution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Decrypts the source snapshot and re-encrypts this account's copy.
      # Without it, distribution fails with a KMS AccessDenied (typically on
      # kms:CreateGrant or kms:DescribeKey) and no AMI appears in this
      # account.
      {
        Sid    = "UseSourceKmsKey"
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
          "kms:CreateGrant",
          "kms:ListGrants",
          "kms:RevokeGrant",
        ]
        Resource = var.source_kms_key_arn
      },
      # Writes the AMI ID parameter for this account's copy. Without it, the
      # AMI still arrives but the SSM parameter write fails and the
      # parameter never appears in this account.
      {
        Sid      = "WriteImageBuilderParameters"
        Effect   = "Allow"
        Action   = ["ssm:PutParameter"]
        Resource = "arn:${data.aws_partition.current.partition}:ssm:*:${data.aws_caller_identity.current.account_id}:parameter/imagebuilder/*"
      },
      # The aws:ec2:image parameter data type validates the AMI ID on write,
      # which requires ec2:DescribeImages. The managed policy above also
      # grants it; this mirrors the documented role setup.
      {
        Sid      = "ValidateAmiParameters"
        Effect   = "Allow"
        Action   = ["ec2:DescribeImages"]
        Resource = "*"
      },
    ]
  })
}
