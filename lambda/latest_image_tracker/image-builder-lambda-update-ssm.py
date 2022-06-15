import json
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ssm_parameter_name = '/ec2-imagebuilder/latest'
session = boto3.session.Session()


def lambda_handler(event, context):
    logger.info('Printing event: {}'.format(event))
    process_sns_event(event)
    return None


def process_sns_event(event):
    for record in event['Records']:
        event_message = record['Sns']['Message']

        # convert the event message to json
        message_json = json.loads(event_message)

        # obtain the image state
        image_state = message_json['state']['status']

        # update the SSM parameter if the image state is available
        if image_state == 'AVAILABLE':
            logger.info('Image is available')

            recipe_name = message_json['name']

            for ami in message_json['outputResources']['amis']:
                # obtain ami id
                logger.info('AMI ID: {}'.format(ami['image']))

                # update SSM parameter
                ssm_client = session.client(
                    service_name='ssm',
                    region_name=ami['region'],
                )
                response = ssm_client.put_parameter(
                    Name=ssm_parameter_name,
                    Description='Latest AMI ID',
                    Value=ami['image'],
                    Type='String',
                    Overwrite=True,
                    Tier='Standard',
                )
                logger.info('SSM Updated: {}'.format(response))

                # add tags to the SSM parameter
                ssm_client.add_tags_to_resource(
                    ResourceType='Parameter',
                    ResourceId=ssm_parameter_name,
                    Tags=[
                        {'Key': 'Source', 'Value': 'EC2 Image Builder'},
                        {'Key': 'AMI_REGION', 'Value': ami['region']},
                        {'Key': 'AMI_ID', 'Value': ami['image']},
                        {'Key': 'AMI_NAME', 'Value': ami['name']},
                        {'Key': 'RECIPE_NAME', 'Value': recipe_name},
                        {
                            'Key': 'SOURCE_PIPELINE_ARN',
                            'Value': message_json['sourcePipelineArn'],
                        },
                    ],
                )

    # end of Lambda function
    return None
