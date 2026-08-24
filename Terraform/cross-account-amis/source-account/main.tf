# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  component_document = file("${path.module}/components/build-info.yml")
  parent_image_name  = "amazon-linux-2023-x86"

  # Components and recipes register under a fixed name + version pair, so
  # versions derive a numeric patch from a content hash: change the inputs
  # and the version changes with them. Recipes are immutable, so the recipe
  # hash must cover every recipe-shaping input here - extend it if you
  # change other arguments, or bump the version by hand.
  component_version = "1.0.${parseint(substr(sha256(local.component_document), 0, 4), 16)}"
  recipe_version    = "1.0.${parseint(substr(sha256(jsonencode([local.component_version, local.parent_image_name])), 0, 4), 16)}"
}

# ---------------------------------------------------------------------------
# Encrypts the image and every copy distributed to the target accounts. A
# customer managed key is required here: target accounts can never be granted
# use of this account's EBS default key.
# ---------------------------------------------------------------------------
resource "aws_kms_key" "image_encryption" {
  description         = "Encrypts AMIs built by the cross-account distribution sample (Terraform)"
  enable_key_rotation = true
  # Shortest deletion window KMS allows (7-30 days), so destroy releases the
  # key as quickly as possible.
  deletion_window_in_days = 7

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Keeps this account in control of the key: IAM policies in the
      # account (including the Image Builder service-linked role's) can
      # grant access, and the key can't become unmanageable.
      {
        Sid       = "EnableIAMUserPermissions"
        Effect    = "Allow"
        Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      # The build path: the build instance reads and writes EBS volumes
      # encrypted with this key.
      {
        Sid       = "AllowBuildInstanceUseOfTheKey"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.instance.arn }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ]
        Resource = "*"
      },
      # Grants each target ACCOUNT use of the key - deliberately wider than
      # the distribution role, because copies stay encrypted with this key,
      # so every principal that launches instances from a copy needs it too.
      {
        Sid       = "AllowTargetAccountUseOfTheKey"
        Effect    = "Allow"
        Principal = { AWS = [for id in var.target_account_ids : "arn:${data.aws_partition.current.partition}:iam::${id}:root"] }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ]
        Resource = "*"
      },
      # EC2 and EBS in the target accounts create grants on this key when
      # instances launch from the copied AMI. GrantIsForAWSResource limits
      # that to grants AWS services create on the caller's behalf - removing
      # the condition lets any principal in a target account hand out
      # arbitrary grants on this key.
      {
        Sid       = "AllowTargetAccountGrantsForAWSResources"
        Effect    = "Allow"
        Principal = { AWS = [for id in var.target_account_ids : "arn:${data.aws_partition.current.partition}:iam::${id}:root"] }
        Action = [
          "kms:CreateGrant",
          "kms:ListGrants",
          "kms:RevokeGrant",
        ]
        Resource = "*"
        Condition = {
          Bool = { "kms:GrantIsForAWSResource" = true }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "image_encryption" {
  name          = "alias/cross-account-sample-tf"
  target_key_id = aws_kms_key.image_encryption.key_id
}

# ---------------------------------------------------------------------------
# The build instance profile. The two managed policies are the supported
# baseline for Image Builder build instances.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "instance" {
  name_prefix = "cross-account-sample-tf-"
  path        = "/executionServiceEC2Role/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "imagebuilder_instance" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/EC2InstanceProfileForImageBuilder"
}

resource "aws_iam_instance_profile" "instance" {
  name_prefix = "cross-account-sample-tf-"
  path        = "/executionServiceEC2Role/"
  role        = aws_iam_role.instance.name
}

# ---------------------------------------------------------------------------
# Build resources.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "build" {
  name              = "/aws/imagebuilder/cross-account-sample-tf"
  retention_in_days = 7
}

resource "aws_imagebuilder_component" "build_info" {
  name     = "cross-account-sample-tf-build-info"
  version  = local.component_version
  platform = "Linux"
  # file() does no interpolation, so component documents keep their shell
  # syntax as written - templatefile() would require escaping every $ sign.
  data = local.component_document

  # A version bump replaces the component; creating the new one first keeps
  # the recipe update atomic - the content hash gives the replacement a
  # different version.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_imagebuilder_image_recipe" "this" {
  name    = "cross-account-sample-tf"
  version = local.recipe_version
  # x.x.x resolves to the latest release of the managed parent image at
  # build time, so each build starts from the current base release.
  parent_image = "arn:${data.aws_partition.current.partition}:imagebuilder:${data.aws_region.current.region}:aws:image/${local.parent_image_name}/x.x.x"

  component {
    component_arn = aws_imagebuilder_component.build_info.arn
  }

  # The explicit root mapping is what ties the image to the customer managed
  # key. Omitting it silently encrypts the root volume with the account's
  # EBS default key instead of this key, and cross-account distribution of
  # the AMI then fails.
  block_device_mapping {
    device_name = "/dev/xvda"

    ebs {
      delete_on_termination = true
      encrypted             = true
      kms_key_id            = aws_kms_key.image_encryption.arn
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_imagebuilder_infrastructure_configuration" "this" {
  name                  = "cross-account-sample-tf"
  instance_profile_name = aws_iam_instance_profile.instance.name

  instance_metadata_options {
    http_tokens = "required"
  }
  # Build instances launch in the account's default VPC. Without a default
  # VPC, set subnet_id and security_group_ids here.
}

resource "aws_imagebuilder_distribution_configuration" "this" {
  name = "cross-account-sample-tf"

  distribution {
    region = data.aws_region.current.region

    ami_distribution_configuration {
      name = "cross-account-sample-tf-{{ imagebuilder:buildDate }}"
      # target_account_ids copies the AMI: each target account gets its own
      # AMI and snapshots that it fully owns. This is distinct from
      # launch_permission (deliberately omitted here), which would let
      # target accounts launch the source-owned AMI instead.
      target_account_ids = var.target_account_ids
      # Encrypts every copy with the customer managed key. Without this,
      # copies fall back to the EBS default key and target accounts can't
      # use them. The full key ARN is required: the target account resolves
      # this value during its copy, and a bare key ID only resolves in the
      # key's own account.
      kms_key_id = aws_kms_key.image_encryption.arn
    }

    # Image Builder writes these parameters after distribution, each in the
    # account named by the entry. They aren't Terraform resources, so
    # destroy doesn't delete them (see the README cleanup).
    # No ami_account_id: written in this (source) account with the source
    # AMI ID.
    ssm_parameter_configuration {
      parameter_name = "/imagebuilder/cross-account-sample-tf/source-ami"
      data_type      = "aws:ec2:image"
    }

    # ami_account_id picks WHICH account's copied AMI ID lands in the
    # parameter, and the parameter is written in that account through its
    # EC2ImageBuilderDistributionCrossAccountRole. One entry per target
    # account - this covers the first; duplicate it for others.
    ssm_parameter_configuration {
      parameter_name = "/imagebuilder/cross-account-sample-tf/target-ami"
      data_type      = "aws:ec2:image"
      ami_account_id = var.target_account_ids[0]
    }
  }
}

# No schedule: the pipeline is run manually (see the README) so the
# target-account roles can be in place before the first distribution.
resource "aws_imagebuilder_image_pipeline" "this" {
  name                             = "cross-account-sample-tf"
  image_recipe_arn                 = aws_imagebuilder_image_recipe.this.arn
  infrastructure_configuration_arn = aws_imagebuilder_infrastructure_configuration.this.arn
  distribution_configuration_arn   = aws_imagebuilder_distribution_configuration.this.arn
}
