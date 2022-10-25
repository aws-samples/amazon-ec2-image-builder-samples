#!/bin/bash -xe

function pre_execute() {
    if [ -f "/tmp/imagebuilder_service/TOE_EXIT_CODE" ] ; then
        EXIT_CODE=$(</tmp/imagebuilder_service/TOE_EXIT_CODE)
        cat /tmp/imagebuilder_service/TOE_LOGS
        exit -1
    fi
}

pre_execute

cat << 'EOF' > /tmp/imagebuilder_service/docker-build.sh
#!/bin/bash

# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this
# software and associated documentation files (the "Software"), to deal in the Software
# without restriction, including without limitation the rights to use, copy, modify,
# merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
# PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
# HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
# OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
# SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

WORKING_DIR="/tmp"
IMAGE_BUILDER_DIR="${WORKING_DIR}/imagebuilder"
TOE_DIR="${IMAGE_BUILDER_DIR}/TaskOrchestratorAndExecutor"
TOE_LOG_DIR="/var/lib/amazon/toe"
BOOTSTRAP_DIR="${IMAGE_BUILDER_DIR}/bootstrap"

function error_exit {
        echo $1
        echo "{\\"failureMessage\\":\\"$2\\"}"
        exit 1
}

function package_exists() {
    if [ $1 == "TOE" ] ; then
        if [ -f "${TOE_DIR}/awstoe" ]; then return 0
        else return 1
        fi
    else
        $(type "$1" > /dev/null 2>&1 )
        return $?
    fi
}

function install_package() {
    if [ $1 == "TOE" ] ; then
        if ! package_exists curl ; then
            install_package curl
        fi
        curl https://ec2imagebuilder-toe-<REGION>-prod.s3.<REGION>.amazonaws.com/bootstrap_scripts/bootstrap.sh -o ${TOE_DIR}/bootstrap.sh --silent --create-dirs
        chmod +x ${TOE_DIR}/bootstrap.sh
        stderr=$(${TOE_DIR}/bootstrap.sh ${TOE_DIR} 2>&1)
        if [ $? -ne 0 ]; then
            error_exit "$stderr" "Unable to bootstrap TOE"
        fi
        if [ -f "${BOOTSTRAP_DIR}/curl" ] ; then
            remove_package curl
            rm -f ${BOOTSTRAP_DIR}/curl
        fi
    elif package_exists yum ; then
        yum install -y -q $1
    elif package_exists apt-get ; then
        apt-get update -y -qq
        apt-get install -y -qq $1
    else
        echo "Unable to install package '$1'"
        exit -1
    fi

    touch ${BOOTSTRAP_DIR}/$1
}

function remove_package() {
    if [ $1 == "TOE" ] ; then
        rm -rf ${TOE_DIR}
    elif package_exists yum ; then
        yum remove -y -q $1
    elif package_exists apt-get ; then
        apt-get remove -y -qq $1
    else
        echo "Unable to remove package '$1'"
        exit -1
    fi
}

function bootstrap() {
    mkdir -p ${BOOTSTRAP_DIR}
    if ! package_exists TOE ; then
        install_package TOE
    fi
}

function cleanup() {
    for filename in $(ls ${BOOTSTRAP_DIR}/)
    do
        if [ "TOE" != $filename ] ; then
            remove_package $filename
        fi
    done
}

function cleanup_toe() {
    if [[ -d "${TOE_LOG_DIR}" ]]; then
        rm -rf ${TOE_LOG_DIR}
    fi
    if [[ -d "${IMAGE_BUILDER_DIR}" ]]; then
        rm -rf ${IMAGE_BUILDER_DIR}
    fi
}

function pre_execute() {
    if [ ! -f "${WORKING_DIR}/perform_cleanup" ] ; then
        touch ${WORKING_DIR}/perform_cleanup
    fi

    if [ -f "${IMAGE_BUILDER_DIR}/TOE_EXIT_CODE" ] ; then
        EXIT_CODE=$(<${IMAGE_BUILDER_DIR}/TOE_EXIT_CODE)
        cat ${IMAGE_BUILDER_DIR}/TOE_LOGS
        exit $EXIT_CODE
    fi
}

pre_execute

bootstrap

cat << 'EOS' > ${IMAGE_BUILDER_DIR}/build_input_config.json
{
  "phases": "build,validate",
  "documents": [
    {
      "path": "<Image Builder Component ARN>"
    }
  ]
}
EOS

PHASE=build,validate

AWSTOE_IMAGEBUILDER_ENDPOINT=https://imagebuilder.<REGION>.amazonaws.com ${TOE_DIR}/awstoe run --config ${IMAGE_BUILDER_DIR}/build_input_config.json -p ${PHASE} -l ${TOE_LOG_DIR} | tee ${IMAGE_BUILDER_DIR}/TOE_LOGS

EXIT_CODE=${PIPESTATUS[0]}
if [ $EXIT_CODE != "194" ] ; then
    echo "$EXIT_CODE" > "${IMAGE_BUILDER_DIR}/TOE_EXIT_CODE"
fi

if [ $EXIT_CODE != "0" ] ; then
    exit $EXIT_CODE
fi

cleanup
cleanup_toe
EOF

aws imagebuilder get-container-recipe --container-recipe-arn <Container Recipe ARN>  --endpoint-url https://imagebuilder.<REGION>.amazonaws.com --region <REGION> --query 'containerRecipe.dockerfileTemplateData' --output text > /tmp/imagebuilder_service/dockerfile_template

sed -i 's/imagebuilder:parentImage/parentImage/g; s/imagebuilder:environments/environments/g; s/imagebuilder:components/components/g' /tmp/imagebuilder_service/dockerfile_template

echo "$(</tmp/imagebuilder_service/dockerfile_template)" | parentImage="amazonlinux:latest" environments="WORKDIR /tmp
COPY container_bootstrap.sh docker-build.sh container_cleanup.sh /tmp/" components="RUN chmod +x /tmp/container_bootstrap.sh && /tmp/container_bootstrap.sh && chmod +x /tmp/docker-build.sh && /tmp/docker-build.sh && chmod +x /tmp/container_cleanup.sh && /tmp/container_cleanup.sh && rm -f /tmp/container_bootstrap.sh && rm -f /tmp/docker-build.sh && rm -f /tmp/container_cleanup.sh" /tmp/imagebuilder_service/mo > /tmp/imagebuilder_service/Dockerfile

NAME=$(uuidgen)
echo ${NAME} > /tmp/imagebuilder_service/image-name
docker build -t ${NAME} -f /tmp/imagebuilder_service/Dockerfile /tmp/imagebuilder_service | tee /tmp/imagebuilder_service/TOE_LOGS

EXIT_CODE=${PIPESTATUS[0]}
if [ $EXIT_CODE != "0" ] ; then
    echo "$EXIT_CODE" > /tmp/imagebuilder_service/TOE_EXIT_CODE
    exit -1
fi
