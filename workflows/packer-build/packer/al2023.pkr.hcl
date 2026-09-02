# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# A small Packer template the pipeline runs as-is. Nothing here is
# required by the integration - bring your own template instead and it
# works unchanged, as long as it produces one AWS AMI and the instance it
# launches is reachable from the build instance.

packer {
  required_plugins {
    amazon = {
      source = "github.com/hashicorp/amazon"
      # Pinned exactly so builds are reproducible - bump deliberately.
      version = "1.8.2"
    }
  }
}

# The run-packer component exports these three values from the build
# instance's own metadata, so the template needs no per-account edits.
# Placing the Packer instance in the build instance's subnet is what makes
# the private-IP SSH connection below work.
variable "region" {
  type    = string
  default = env("AWS_REGION")
}

variable "subnet_id" {
  type    = string
  default = env("IMAGEBUILDER_SUBNET_ID")
}

variable "build_ip" {
  type    = string
  default = env("IMAGEBUILDER_BUILD_IP")
}

source "amazon-ebs" "al2023" {
  region        = var.region
  subnet_id     = var.subnet_id
  instance_type = "t3.micro"
  ami_name      = "packer-build-{{timestamp}}"

  source_ami_filter {
    filters = {
      name                = "al2023-ami-2023*-kernel-*-x86_64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["amazon"]
    most_recent = true
  }

  # Packer connects over the private IP - the build instance sits in the
  # same subnet, so the Packer instance needs no public IP and the
  # temporary security group opens SSH to the build instance alone.
  ssh_username                          = "ec2-user"
  ssh_interface                         = "private_ip"
  associate_public_ip_address           = false
  temporary_security_group_source_cidrs = ["${var.build_ip}/32"]

  # Both instance settings and the AMI stamp: metadata_options covers the
  # instance packer launches, imds_support marks the resulting AMI as
  # IMDSv2-only at launch time.
  imds_support = "v2.0"
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
}

build {
  sources = ["source.amazon-ebs.al2023"]

  # Stand-in for real provisioning. The pipeline's test stage boots the
  # finished AMI and checks this file is present.
  provisioner "shell" {
    inline = [
      "echo \"Built by packer $(date -u '+%Y-%m-%dT%H:%M:%SZ')\" | sudo tee /etc/packer-built.txt",
    ]
  }
}
