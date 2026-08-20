
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
    if event.get("RequestType") in ["Create", "Update"]:
        # The CDK provider framework reports failure to CloudFormation only
        # when the handler raises, so unexpected errors must propagate.
        try:
            imgbuilder_client.start_image_pipeline_execution(
                imagePipelineArn=event.get("ResourceProperties")["PIPELINE_ARN"]
            )
        except imgbuilder_client.exceptions.ResourceNotFoundException:
            logger.info("ResourceNotFoundException - nothing to trigger.")

    return {"PhysicalResourceId": "img-builder-trigger-cr"}
