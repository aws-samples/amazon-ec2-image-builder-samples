# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Container for running AWSTOE component documents locally: a rebooting step
# can't touch the host, and the filesystem the component mutates is thrown
# away with the container.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# awscli is for documents that shell out to the AWS CLI - none of the
# cookbook's do, but yours might. Credentials pass through from the host.
RUN dnf -y -q install findutils awscli-2 && dnf clean all

COPY awstoe-local.sh /usr/local/bin/awstoe-local.sh
RUN chmod +x /usr/local/bin/awstoe-local.sh

WORKDIR /work
# Root inside the container is intended - a reboot or crontab write can't
# reach the host.
ENV AWSTOE_IN_CONTAINER=1
ENTRYPOINT ["/usr/local/bin/awstoe-local.sh"]
