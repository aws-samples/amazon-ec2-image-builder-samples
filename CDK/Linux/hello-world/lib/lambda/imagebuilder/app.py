
from time import sleep
import boto3
import logging
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)
imgbuilder_client = boto3.client("imagebuilder")

def lambda_handler(event, _):
    """
    response to image builder trigger event
    """
    logger.info("triggering new pipeline")

    logger.info(event)
    request_type = event.get("RequestType")
    if request_type not in ["Create", "Update"]:
        return create_cfn_response(event, "SUCCESS", "skipped")
    pipeline_arn = event.get("ResourceProperties")["PIIPELINE_ARN"]

    try:
        imgbuilder_client.start_image_pipeline_execution(
            imagePipelineArn=pipeline_arn
        )
    except Exception as e:
        if e.response["Error"]["Code"]== "ResourceNotFoundException":
            logger.info("ResourceNotFoundException - nothing to trigger.")
        else:
            logger.error(e)
            return create_cfn_response(
                event, "FAILED", "failed to trigger pipeline"
            )

    return create_cfn_response(event, "SUCCESS", "triggered pipeline")


def create_cfn_response(event, status: str, reason: str) -> dict:
    return {
        "RequestId": event.get("RequestId"),
        "LogicalResourceId": event.get("LogicalResourceId"),
        "PhysicalResourceId": "img-builder-trigger-cr",
        "StackId": event.get("StackId"),
        "Status": status,
        "Reason": reason,
    }
